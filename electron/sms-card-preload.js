'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smsCard', {
  onShow: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms-card:show', listener);
    return () => ipcRenderer.removeListener('sms-card:show', listener);
  },
  onHide: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms-card:hide', listener);
    return () => ipcRenderer.removeListener('sms-card:hide', listener);
  },
  open: (peer) => ipcRenderer.invoke('sms-card:open', { peer }),
  dismiss: () => ipcRenderer.invoke('sms-card:dismiss'),
});
