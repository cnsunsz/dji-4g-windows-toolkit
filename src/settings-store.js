'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  openAtLogin: false,
  closeToTray: true,
  notifyOnCall: true,
  popupOnCall: true,
  autoConnect: true,
  flashTrayOnRing: true,
};

/**
 * Persist app settings under Electron userData (JSON).
 */
class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...pickKnown(parsed) };
      }
    } catch {
      this.data = { ...DEFAULTS };
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const out = { ...this.data, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2), 'utf8');
  }

  getAll() {
    return { ...DEFAULTS, ...this.data };
  }

  get(key) {
    const all = this.getAll();
    return all[key];
  }

  set(partial) {
    const next = pickKnown(partial || {});
    this.data = { ...this.getAll(), ...next };
    this._save();
    return this.getAll();
  }
}

function pickKnown(obj) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = !!obj[k];
    }
  }
  return out;
}

module.exports = {
  SettingsStore,
  DEFAULTS,
};
