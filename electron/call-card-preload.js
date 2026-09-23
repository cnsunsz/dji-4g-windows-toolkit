'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callCard', {
  onShow: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('call-card:show', listener);
    return () => ipcRenderer.removeListener('call-card:show', listener);
  },
  onHide: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('call-card:hide', listener);
    return () => ipcRenderer.removeListener('call-card:hide', listener);
  },
  answer: () => ipcRenderer.invoke('call:answer'),
  reject: () => ipcRenderer.invoke('call:hangup'),
});
