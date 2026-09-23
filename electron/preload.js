'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toolkit', {
  getInfo: () => ipcRenderer.invoke('app:getInfo'),
  showMain: () => ipcRenderer.invoke('app:showMain'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  resolveRingtone: () => ipcRenderer.invoke('ringtone:resolve'),
  pickCustomRingtone: () => ipcRenderer.invoke('ringtone:pickCustom'),
  clearCustomRingtone: () => ipcRenderer.invoke('ringtone:clearCustom'),
  installDrivers: () => ipcRenderer.invoke('driver:install'),
  installWwanDriver: () => ipcRenderer.invoke('driver:installWwan'),
  detectDevice: (opts) => ipcRenderer.invoke('device:detect', opts),
  smsStatus: () => ipcRenderer.invoke('sms:status'),
  smsMessages: () => ipcRenderer.invoke('sms:messages'),
  smsThreads: () => ipcRenderer.invoke('sms:threads'),
  smsMarkRead: (peer, iccid) => ipcRenderer.invoke('sms:markRead', { peer, iccid }),
  smsReconnect: () => ipcRenderer.invoke('sms:reconnect'),
  smsRefresh: () => ipcRenderer.invoke('sms:refresh'),
  smsSend: (to, text) => ipcRenderer.invoke('sms:send', { to, text }),
  smsDelete: (storage, index) => ipcRenderer.invoke('sms:delete', { storage, index }),
  smsDeleteMany: (items) => ipcRenderer.invoke('sms:deleteMany', { items }),
  smsDeleteAll: (storage) => ipcRenderer.invoke('sms:deleteAll', { storage }),
  smsDeleteOutbound: (id, iccid) => ipcRenderer.invoke('sms:deleteOutbound', { id, iccid }),
  smsClearThread: (peer, iccid) => ipcRenderer.invoke('sms:clearThread', { peer, iccid }),
  smsEnableIms: (reboot) => ipcRenderer.invoke('sms:enableIms', { reboot: !!reboot }),
  msisdnGet: () => ipcRenderer.invoke('msisdn:get'),
  msisdnSet: (number, iccid) => ipcRenderer.invoke('msisdn:set', { number, iccid }),
  ussdSend: (code) => ipcRenderer.invoke('ussd:send', { code }),
  callStatus: () => ipcRenderer.invoke('call:status'),
  callDial: (number) => ipcRenderer.invoke('call:dial', { number }),
  callAnswer: () => ipcRenderer.invoke('call:answer'),
  callHangup: () => ipcRenderer.invoke('call:hangup'),
  callQueryUsbcfg: () => ipcRenderer.invoke('call:queryUsbcfg'),
  callEnableUsbAudio: (reboot) => ipcRenderer.invoke('call:enableUsbAudio', { reboot: !!reboot }),
  callRestoreUsbcfg: (reboot) => ipcRenderer.invoke('call:restoreUsbcfg', { reboot: !!reboot }),
  callTryQpcmv: () => ipcRenderer.invoke('call:tryQpcmv'),
  atRaw: (command, timeout) => ipcRenderer.invoke('at:raw', { command, timeout }),
  onSmsUrc: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms:urc', listener);
    return () => ipcRenderer.removeListener('sms:urc', listener);
  },
  onCallUrc: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('call:urc', listener);
    return () => ipcRenderer.removeListener('call:urc', listener);
  },
  onIncomingCallPopup: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('call:incoming-popup', listener);
    return () => ipcRenderer.removeListener('call:incoming-popup', listener);
  },
  onNewInboundSms: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms:new-inbound', listener);
    return () => ipcRenderer.removeListener('sms:new-inbound', listener);
  },
  onOpenSmsThread: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('sms:open-thread', listener);
    return () => ipcRenderer.removeListener('sms:open-thread', listener);
  },
});
