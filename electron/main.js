'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
} = require('electron');

const { detectStatus } = require('../src/device');
const { AtModem } = require('../src/modem');
const { launchElevatedInstall, resourcePaths } = require('../src/driver');
const {
  MsisdnStore,
  extractCnMobiles,
  resolveEffectiveMsisdn,
} = require('../src/msisdn-store');
const { SettingsStore } = require('../src/settings-store');
const { SmsThreadStore, buildThreads } = require('../src/sms-thread-store');
const { normalizePeer, displayPeer } = require('../src/phone-normalize');

// Windows toast / jump-list identity
if (process.platform === 'win32') {
  app.setAppUserModelId('com.cnsunsz.dji4gtoolkit');
}

const APP_VERSION = app.getVersion();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayFlashTimer = null;
let lastIncomingCallNumber = null;

const modem = new AtModem();
let msisdnStore = null;
let settingsStore = null;
let smsThreadStore = null;

function getMsisdnStore() {
  if (!msisdnStore) {
    const filePath = path.join(app.getPath('userData'), 'msisdn-by-iccid.json');
    msisdnStore = new MsisdnStore(filePath);
  }
  return msisdnStore;
}

function getSettingsStore() {
  if (!settingsStore) {
    const filePath = path.join(app.getPath('userData'), 'settings.json');
    settingsStore = new SettingsStore(filePath);
  }
  return settingsStore;
}

function getSmsThreadStore() {
  if (!smsThreadStore) {
    const filePath = path.join(app.getPath('userData'), 'sms-threads-by-iccid.json');
    smsThreadStore = new SmsThreadStore(filePath);
  }
  return smsThreadStore;
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

function currentIccid() {
  return modem.status().iccid || null;
}

function gatherThreads() {
  const status = enrichStatus(modem.status());
  const iccid = status.iccid;
  const inbound = modem.messages();
  const outbound = getSmsThreadStore().listOutbound(iccid);
  const readAt = getSmsThreadStore().getReadMap(iccid);
  const threads = buildThreads(inbound, outbound, readAt);
  return { status, threads, iccid };
}

function iconPath() {
  // Prefer Windows .ico, then PNG (dev tree and packaged resources)
  const names = ['icon.ico', 'icon.png'];
  const dirs = [
    path.join(__dirname, '..', 'build'),
    path.join(process.resourcesPath || '', 'build'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'build'),
  ];
  const candidates = [];
  for (const dir of dirs) {
    for (const name of names) {
      candidates.push(path.join(dir, name));
    }
  }
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function loadAppIcon() {
  const p = iconPath();
  if (p) return nativeImage.createFromPath(p);
  // 1x1 fallback
  return nativeImage.createEmpty();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: `DJI 4G Windows Toolkit  v${APP_VERSION}`,
    backgroundColor: '#f9fafb',
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.on('close', (e) => {
    const settings = getSettingsStore().getAll();
    if (!isQuitting && settings.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildTrayMenu() {
  const call = modem.callStatus();
  const ringing = call.state === 'ringing';
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '接听',
      enabled: ringing,
      click: async () => {
        try {
          await modem.answer();
          stopTrayFlash();
          broadcastCall();
        } catch {
          /* ignore */
        }
      },
    },
    {
      label: '挂断',
      enabled: call.state === 'ringing' || call.state === 'active' || call.state === 'dialing',
      click: async () => {
        try {
          await modem.hangup();
          stopTrayFlash();
          broadcastCall();
        } catch {
          /* ignore */
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        stopTrayFlash();
        app.quit();
      },
    },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    let img = loadAppIcon();
    if (img.isEmpty()) {
      // Tiny blue pixel as last resort
      img = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPElEQVRYCe3OMQEAAAjDMMC/5+ECfpA0kkmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmS/g0c0AABfGkY2wAAAABJRU5ErkJggg=='
      );
    }
    if (img.getSize().width > 32) {
      img = img.resize({ width: 16, height: 16 });
    }
    tray = new Tray(img);
    tray.setToolTip('DJI 4G Windows Toolkit');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    console.warn('Tray unavailable:', err && err.message ? err.message : err);
    tray = null;
  }
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function startTrayFlash() {
  const settings = getSettingsStore().getAll();
  if (!settings.flashTrayOnRing || !tray) return;
  stopTrayFlash();
  let on = false;
  trayFlashTimer = setInterval(() => {
    if (!tray) return;
    on = !on;
    if (on) tray.setHighlightMode && tray.setHighlightMode('always');
    try {
      tray.setToolTip(on ? '来电振铃…' : 'DJI 4G Windows Toolkit');
    } catch {
      /* ignore */
    }
  }, 600);
}

function stopTrayFlash() {
  if (trayFlashTimer) {
    clearInterval(trayFlashTimer);
    trayFlashTimer = null;
  }
  if (tray) {
    try {
      tray.setToolTip('DJI 4G Windows Toolkit');
    } catch {
      /* ignore */
    }
  }
}

function broadcastUrc(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sms:urc', payload);
    if (payload && (payload.type === 'CALL' || payload.type === 'CUSD')) {
      mainWindow.webContents.send('call:urc', payload);
    }
  }
}

function broadcastCall() {
  const data = modem.callStatus();
  const payload = {
    type: 'CALL',
    state: data.state,
    number: data.number,
    clip: data.clip,
  };
  broadcastUrc(payload);
  refreshTrayMenu();
}

function notifyIncomingCall(number) {
  const settings = getSettingsStore().getAll();
  lastIncomingCallNumber = number || lastIncomingCallNumber;

  if (settings.popupOnCall && mainWindow && !mainWindow.isDestroyed()) {
    const focused = mainWindow.isVisible() && mainWindow.isFocused();
    if (focused || mainWindow.isVisible()) {
      mainWindow.webContents.send('call:incoming-popup', {
        number: lastIncomingCallNumber,
        display: displayPeer(lastIncomingCallNumber),
      });
    }
  }

  if (!settings.notifyOnCall) return;
  if (!Notification.isSupported()) return;

  const body = displayPeer(lastIncomingCallNumber) || '未知号码';
  const opts = {
    title: '来电',
    body: `来自 ${body}`,
    silent: false,
  };
  // Actions: supported on some platforms; Windows may ignore — fallback is click.
  try {
    opts.actions = [
      { type: 'button', text: '接听' },
      { type: 'button', text: '挂断' },
    ];
  } catch {
    /* ignore */
  }

  let n;
  try {
    n = new Notification(opts);
  } catch {
    n = new Notification({ title: '来电', body: `来自 ${body}` });
  }

  n.on('click', () => {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('call:incoming-popup', {
        number: lastIncomingCallNumber,
        display: displayPeer(lastIncomingCallNumber),
      });
    }
  });
  n.on('action', async (_e, index) => {
    try {
      if (index === 0) await modem.answer();
      else if (index === 1) await modem.hangup();
      stopTrayFlash();
      broadcastCall();
    } catch {
      /* ignore */
    }
  });
  n.show();
}

function applyLoginItem(settings) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.openAtLogin,
      path: process.execPath,
      args: [],
    });
  } catch {
    /* ignore on non-packaged / linux */
  }
}

modem.setUrcHandler((payload) => {
  broadcastUrc(payload);
  if (payload && payload.type === 'CALL') {
    refreshTrayMenu();
    if (payload.state === 'ringing') {
      const num = payload.clip || payload.number || null;
      notifyIncomingCall(num);
      startTrayFlash();
      // If window hidden (tray), still try popup when shown and toast above
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        // toast already fired; tray menu updated
      }
    } else if (payload.state === 'idle' || payload.state === 'active' || payload.state === 'ending') {
      stopTrayFlash();
    }
  }
  if (payload && payload.type === 'CMTI') {
    // New inbound SMS — renderer will refresh; nudge unread via threads IPC optional
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sms:new-inbound', payload);
    }
  }
});

app.whenReady().then(async () => {
  getMsisdnStore();
  getSettingsStore();
  getSmsThreadStore();
  const settings = getSettingsStore().getAll();
  applyLoginItem(settings);
  createTray();
  createWindow();

  if (settings.autoConnect) {
    try {
      await modem.connect();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', () => {
          mainWindow.webContents.send('sms:urc', { type: 'AUTO_CONNECT' });
        });
      }
    } catch {
      /* ignore — UI can reconnect */
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopTrayFlash();
});

app.on('window-all-closed', () => {
  const settings = getSettingsStore().getAll();
  if (settings.closeToTray && !isQuitting) {
    // Keep modem alive in tray
    return;
  }
  modem.stop().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

ipcMain.handle('app:getInfo', async () => ({
  version: APP_VERSION,
  platform: process.platform,
  resources: resourcePaths(),
}));

ipcMain.handle('settings:get', async () => getSettingsStore().getAll());

ipcMain.handle('settings:set', async (_evt, partial) => {
  const next = getSettingsStore().set(partial || {});
  applyLoginItem(next);
  return { ok: true, settings: next };
});

ipcMain.handle('app:showMain', async () => {
  showMainWindow();
  return { ok: true };
});

ipcMain.handle('driver:install', async () => launchElevatedInstall());

ipcMain.handle('driver:installWwan', async () => launchElevatedInstall({ wwanOnly: true }));

ipcMain.handle('device:detect', async (_evt, opts) => detectStatus(opts || { probe: true }));

ipcMain.handle('sms:status', async () => enrichStatus(modem.status()));

ipcMain.handle('sms:messages', async () => ({ messages: modem.messages() }));

ipcMain.handle('sms:threads', async () => gatherThreads());

ipcMain.handle('sms:markRead', async (_evt, payload) => {
  const iccid = payload?.iccid || currentIccid();
  getSmsThreadStore().markRead(iccid, payload?.peer, Date.now());
  return gatherThreads();
});

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
  detectedNumbers.sort((a, b) => Number(b.ownContext) - Number(a.ownContext));
  const threadsData = gatherThreads();
  return { status, messages, detectedNumbers, threads: threadsData.threads };
});

ipcMain.handle('sms:send', async (_evt, payload) => {
  try {
    const to = payload?.to;
    const text = payload?.text;
    await modem.send(to, text);
    const iccid = currentIccid();
    try {
      getSmsThreadStore().addOutbound(iccid, {
        peer: to,
        body: text,
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* local persist failure should not fail send */
    }
    return { ok: true, threads: gatherThreads().threads, status: enrichStatus(modem.status()) };
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
    return {
      ok: true,
      ...result,
      status: enrichStatus(result.status),
      threads: gatherThreads().threads,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
      threads: gatherThreads().threads,
    };
  }
});

ipcMain.handle('sms:deleteMany', async (_evt, payload) => {
  try {
    const result = await modem.deleteMessages(payload?.items || []);
    return {
      ok: true,
      ...result,
      status: enrichStatus(result.status),
      threads: gatherThreads().threads,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
      threads: gatherThreads().threads,
    };
  }
});

ipcMain.handle('sms:deleteAll', async (_evt, payload) => {
  try {
    const result = await modem.deleteAll({ storage: payload?.storage });
    return {
      ok: true,
      ...result,
      status: enrichStatus(result.status),
      threads: gatherThreads().threads,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      messages: modem.messages(),
      threads: gatherThreads().threads,
    };
  }
});

ipcMain.handle('sms:deleteOutbound', async (_evt, payload) => {
  try {
    const iccid = payload?.iccid || currentIccid();
    getSmsThreadStore().deleteOutbound(iccid, payload?.id);
    return { ok: true, threads: gatherThreads().threads };
  } catch (err) {
    return { ok: false, error: String(err.message || err), threads: gatherThreads().threads };
  }
});

ipcMain.handle('sms:clearThread', async (_evt, payload) => {
  try {
    const peer = payload?.peer;
    const iccid = payload?.iccid || currentIccid();
    const peerKey = normalizePeer(peer);
    // Delete inbound on module for this peer
    const items = modem
      .messages()
      .filter((m) => normalizePeer(m.sender) === peerKey && m.index != null && m.index !== '')
      .map((m) => ({ storage: m.storage || 'SM', index: m.index }));
    let moduleResult = null;
    if (items.length) {
      moduleResult = await modem.deleteMessages(items);
    }
    getSmsThreadStore().clearPeerOutbound(iccid, peerKey);
    return {
      ok: true,
      deletedModule: items.length,
      moduleResult,
      status: enrichStatus(modem.status()),
      threads: gatherThreads().threads,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: enrichStatus(modem.status()),
      threads: gatherThreads().threads,
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
    refreshTrayMenu();
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:answer', async () => {
  try {
    const result = await modem.answer();
    stopTrayFlash();
    refreshTrayMenu();
    return { ok: true, ...result, status: enrichStatus(result.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: enrichStatus(modem.status()) };
  }
});

ipcMain.handle('call:hangup', async () => {
  try {
    const result = await modem.hangup();
    stopTrayFlash();
    refreshTrayMenu();
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

ipcMain.handle('at:raw', async (_evt, payload) => {
  try {
    const result = await modem.atRaw(payload?.command, { timeout: payload?.timeout });
    return { ...result, status: enrichStatus(result.status || modem.status()) };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      raw: String(err.message || err),
      status: enrichStatus(modem.status()),
    };
  }
});

