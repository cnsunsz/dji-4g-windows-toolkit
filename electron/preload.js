'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toolkit', {
  getInfo: () => ipcRenderer.invoke('app:getInfo'),
  installDrivers: () => ipcRenderer.invoke('driver:install'),
  detectDevice: (opts) => ipcRenderer.invoke('device:detect', opts),
  smsStatus: () => ipcRenderer.invoke('sms:status'),
  smsMessages: () => ipcRenderer.invoke('sms:messages'),
  smsReconnect: () => ipcRenderer.invoke('sms:reconnect'),
  smsRefresh: () => ipcRenderer.invoke('sms:refresh'),
  smsSend: (to, text) => ipcRenderer.invoke('sms:send', { to, text }),
  smsDelete: (storage, index) => ipcRenderer.invoke('sms:delete', { storage, index }),
  smsDeleteAll: (storage) => ipcRenderer.invoke('sms:deleteAll', { storage }),
  smsEnableIms: (reboot) => ipcRenderer.invoke('sms:enableIms', { reboot: !!reboot }),
  onSmsUrc: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms:urc', listener);
    return () => ipcRenderer.removeListener('sms:urc', listener);
  },
});
