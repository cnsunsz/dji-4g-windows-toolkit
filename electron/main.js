'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { detectStatus } = require('../src/device');
const { AtModem } = require('../src/modem');
const { launchElevatedInstall, resourcePaths } = require('../src/driver');
const {
  MsisdnStore,
  extractCnMobiles,
  resolveEffectiveMsisdn,
} = require('../src/msisdn-store');

const APP_VERSION = app.getVersion();
let mainWindow = null;
const modem = new AtModem();
let msisdnStore = null;

function getMsisdnStore() {
  if (!msisdnStore) {
    const filePath = path.join(app.getPath('userData'), 'msisdn-by-iccid.json');
    msisdnStore = new MsisdnStore(filePath);
  }
  return msisdnStore;
}

function enrichStatus(status) {
  const s = status || modem.status();
  const iccid = s.iccid || null;
  const cnum = s.cnum || s.ownNumber || null;
  const saved = iccid ? getMsisdnStore().get(iccid) : null;
  const effective = resolveEffectiveMsisdn({ cnum, saved, iccid });
  return {
    ...s,
    cnum,
    savedMsisdn: saved,
    effectiveMsisdn: effective.number,
    effectiveMsisdnSource: effective.source,
    effectiveMsisdnLabel: effective.label,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: `DJI 4G Windows Toolkit  v${APP_VERSION}`,
    backgroundColor: '#f9fafb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcastUrc(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sms:urc', payload);
    if (payload && (payload.type === 'CALL' || payload.type === 'CUSD')) {
      mainWindow.webContents.send('call:urc', payload);
    }
  }
}

modem.setUrcHandler((payload) => {
  broadcastUrc(payload);
});

app.whenReady().then(() => {
  getMsisdnStore();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  modem.stop().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

ipcMain.handle('app:getInfo', async () => ({
  version: APP_VERSION,
  platform: process.platform,
  resources: resourcePaths(),
}));

ipcMain.handle('driver:install', async () => launchElevatedInstall());

ipcMain.handle('driver:installWwan', async () => launchElevatedInstall({ wwanOnly: true }));

ipcMain.handle('device:detect', async (_evt, opts) => detectStatus(opts || { probe: true }));

ipcMain.handle('sms:status', async () => enrichStatus(modem.status()));

ipcMain.handle('sms:messages', async () => ({ messages: modem.messages() }));

ipcMain.handle('sms:reconnect', async () => enrichStatus(await modem.connect()));

ipcMain.handle('sms:refresh', async () => {
  const data = await modem.refresh();
  const status = enrichStatus(data.status);
  const messages = data.messages || [];
  const detectedNumbers = [];
  const seen = new Set();
  for (const msg of messages) {
    const hits = extractCnMobiles(msg.body || '');
    for (const h of hits) {
      if (seen.has(h.number)) continue;
      seen.add(h.number);
      detectedNumbers.push({
        ...h,
        fromSms: true,
        sender: msg.sender || null,
        timestamp: msg.timestamp || null,
      });
    }
  }
  // Prefer own-context hits first
  detectedNumbers.sort((a, b) => Number(b.ownContext) - Number(a.ownContext));
  return { status, messages, detectedNumbers };
});

ipcMain.handle('sms:send', async (_evt, payload) => {
  try {
    await modem.send(payload?.to, payload?.text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('sms:delete', async (_evt, payload) => {
  try {
    const result = await modem.deleteMessage({
      storage: payload?.storage,
      index: payload?.index,
    });
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:deleteMany', async (_evt, payload) => {
  try {
    const result = await modem.deleteMessages(payload?.items || []);
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:deleteAll', async (_evt, payload) => {
  try {
    const result = await modem.deleteAll({ storage: payload?.storage });
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:enableIms', async (_evt, payload) => {
  try {
    const result = await modem.enableIms({ reboot: !!(payload && payload.reboot) });
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('msisdn:get', async () => {
  const status = enrichStatus(modem.status());
  return {
    ok: true,
    iccid: status.iccid,
    cnum: status.cnum,
    saved: status.savedMsisdn,
    effective: status.effectiveMsisdn,
    source: status.effectiveMsisdnSource,
    label: status.effectiveMsisdnLabel,
    status,
  };
});

ipcMain.handle('msisdn:set', async (_evt, payload) => {
  try {
    const iccid = payload?.iccid || modem.status().iccid;
    const result = getMsisdnStore().set(iccid, payload?.number);
    return { ok: true, ...result, status: enrichStatus(modem.status()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('ussd:send', async (_evt, payload) => {
  try {
    const result = await modem.sendUssd(payload?.code);
    const text = result.text || result.raw || '';
    const detected = extractCnMobiles(text);
    return {
      ok: true,
      ...result,
      detected,
      status: enrichStatus(result.status),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
    };
  }
});

ipcMain.handle('call:status', async () => {
  const data = modem.callStatus();
  return { ...data, status: enrichStatus(data.status) };
});

ipcMain.handle('call:dial', async (_evt, payload) => {
  try {
    const result = await modem.dial(payload?.number);
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:answer', async () => {
  try {
    const result = await modem.answer();
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:hangup', async () => {
  try {
    const result = await modem.hangup();
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:queryUsbcfg', async () => {
  try {
    const result = await modem.queryUsbcfg();
    return { ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:enableUsbAudio', async (_evt, payload) => {
  try {
    const result = await modem.enableUsbAudio({ reboot: !!(payload && payload.reboot) });
    return { ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:restoreUsbcfg', async (_evt, payload) => {
  try {
    const result = await modem.restoreUsbcfg({ reboot: !!(payload && payload.reboot) });
    return { ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:tryQpcmv', async () => {
  try {
    const result = await modem.tryQpcmv();
    return { ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return {
      ok: false,
      qpcmvOk: false,
      error: String(err.message || err),
      message: '本机固件可能无 UAC/QPCMV，通话控制可用但电脑音频可能无声',
      status: enrichStatus(modem.status()),
    };
  }
});
