'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persist user-entered MSISDN keyed by ICCID (JSON under Electron userData).
 * No third-party store dependency.
 */
class MsisdnStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {{ byIccid: Record<string, string>, updatedAt?: string }} */
    this.data = { byIccid: {} };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.byIccid && typeof parsed.byIccid === 'object') {
        this.data = { byIccid: { ...parsed.byIccid }, updatedAt: parsed.updatedAt };
      }
    } catch {
      this.data = { byIccid: {} };
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(iccid) {
    const key = String(iccid || '').trim();
    if (!key) return null;
    const v = this.data.byIccid[key];
    return v ? String(v) : null;
  }

  set(iccid, number) {
    const key = String(iccid || '').trim();
    if (!key) throw new Error('无 ICCID，无法保存本机号码');
    const num = String(number || '').trim();
    if (!num) {
      delete this.data.byIccid[key];
      this._save();
      return { iccid: key, number: null };
    }
    this.data.byIccid[key] = num;
    this._save();
    return { iccid: key, number: num };
  }

  all() {
    return { ...this.data.byIccid };
  }
}

/** Mainland CN mobile: 1[3-9]xxxxxxxxx with optional +86 / 86 prefix */
const CN_MOBILE_RE = /(?:\+?86)?(1[3-9]\d{9})/g;
const OWN_CTX_RE = /本机号码|您的号码|您的手机号|本机手机号|号码为|号码是|查询号码/;

function extractCnMobiles(text) {
  const s = String(text || '');
  const found = [];
  const seen = new Set();
  let m;
  const re = new RegExp(CN_MOBILE_RE.source, 'g');
  while ((m = re.exec(s)) !== null) {
    const n = m[1];
    if (seen.has(n)) continue;
    seen.add(n);
    const start = Math.max(0, m.index - 24);
    const ctx = s.slice(start, m.index + m[0].length + 8);
    found.push({
      number: n,
      e164: `+86${n}`,
      ownContext: OWN_CTX_RE.test(ctx),
      snippet: ctx.replace(/\s+/g, ' ').trim(),
    });
  }
  return found;
}

function resolveEffectiveMsisdn({ cnum, saved, iccid }) {
  const c = cnum && String(cnum).trim() ? String(cnum).trim() : null;
  if (c) {
    return { number: c, source: 'cnum', label: 'CNUM', iccid: iccid || null };
  }
  const s = saved && String(saved).trim() ? String(saved).trim() : null;
  if (s) {
    return { number: s, source: 'saved', label: '已保存', iccid: iccid || null };
  }
  return { number: null, source: 'none', label: '未设置', iccid: iccid || null };
}

module.exports = {
  MsisdnStore,
  extractCnMobiles,
  resolveEffectiveMsisdn,
  CN_MOBILE_RE,
};
