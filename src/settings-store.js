'use strict';

const fs = require('fs');
const path = require('path');

const RINGTONE_IDS = ['mute', 'apple', 'xiaomi', 'samsung', 'custom'];

const DEFAULTS = {
  openAtLogin: false,
  closeToTray: true,
  notifyOnCall: false, // obsolete: system toast removed in v0.8
  popupOnCall: true, // Mac-like corner call card
  autoConnect: true,
  flashTrayOnRing: true,
  ringtone: 'apple',
  ringtoneVolume: 0.85,
  /** Absolute path to user-selected local audio; never bundled in release. */
  customRingtonePath: '',
  popupOnSms: true, // Mac-like corner SMS card (not system toast)
  smsSound: true, // original soft chime
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

function normalizeRingtone(v) {
  const raw = String(v == null ? '' : v).trim();
  const s = raw.toLowerCase();
  if (RINGTONE_IDS.includes(s)) return s;
  const map = {
    静音: 'mute',
    苹果风: 'apple',
    小米风: 'xiaomi',
    三星风: 'samsung',
    自定义: 'custom',
    silent: 'mute',
    none: 'mute',
    local: 'custom',
  };
  if (map[raw] || map[s]) return map[raw] || map[s];
  return DEFAULTS.ringtone;
}

function normalizeVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.ringtoneVolume;
  return Math.max(0, Math.min(1, n));
}

function normalizePath(v) {
  if (v == null || v === false) return '';
  const s = String(v).trim();
  if (!s || s.length > 1024) return '';
  return s;
}

function pickKnown(obj) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (k === 'ringtone') {
      out[k] = normalizeRingtone(obj[k]);
    } else if (k === 'ringtoneVolume') {
      out[k] = normalizeVolume(obj[k]);
    } else if (k === 'customRingtonePath') {
      out[k] = normalizePath(obj[k]);
    } else {
      out[k] = !!obj[k];
    }
  }
  return out;
}

module.exports = {
  SettingsStore,
  DEFAULTS,
  RINGTONE_IDS,
  normalizeRingtone,
};
