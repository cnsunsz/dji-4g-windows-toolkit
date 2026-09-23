'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { detectStatus } = require('../src/device');
const { AtModem } = require('../src/modem');
const { launchElevatedInstall, resourcePaths } = require('../src/driver');

const APP_VERSION = app.getVersion();
let mainWindow = null;
const modem = new AtModem();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 600,
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
  }
}

modem.setUrcHandler((payload) => {
  broadcastUrc(payload);
});

app.whenReady().then(() => {
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

ipcMain.handle('sms:status', async () => modem.status());

ipcMain.handle('sms:messages', async () => ({ messages: modem.messages() }));

ipcMain.handle('sms:reconnect', async () => modem.connect());

ipcMain.handle('sms:refresh', async () => modem.refresh());

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
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: modem.status(),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:deleteMany', async (_evt, payload) => {
  try {
    const result = await modem.deleteMessages(payload?.items || []);
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: modem.status(),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:deleteAll', async (_evt, payload) => {
  try {
    const result = await modem.deleteAll({ storage: payload?.storage });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      status: modem.status(),
      messages: modem.messages(),
    };
  }
});

ipcMain.handle('sms:enableIms', async (_evt, payload) => {
  try {
    const result = await modem.enableIms({ reboot: !!(payload && payload.reboot) });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: modem.status(), messages: modem.messages() };
  }
});
