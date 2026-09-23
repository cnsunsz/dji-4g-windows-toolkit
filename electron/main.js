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
    width: 920,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: `DJI 4G Windows Toolkit  v${APP_VERSION}`,
    backgroundColor: '#0f1419',
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

ipcMain.handle('sms:enableIms', async (_evt, payload) => {
  try {
    const result = await modem.enableIms({ reboot: !!(payload && payload.reboot) });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: modem.status(), messages: modem.messages() };
  }
});
