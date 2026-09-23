'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePeer } = require('./phone-normalize');

function uid() {
  return `out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist outbound SMS (and per-thread read cursors) keyed by ICCID.
 * Inbound messages stay on the modem; this store only holds local-sent copies.
 */
class SmsThreadStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {{ byIccid: Record<string, { outbound: array, readAt: Record<string,number> }> }} */
    this.data = { byIccid: {} };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.byIccid && typeof parsed.byIccid === 'object') {
        this.data = { byIccid: { ...parsed.byIccid } };
      }
    } catch {
      this.data = { byIccid: {} };
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const out = { ...this.data, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2), 'utf8');
  }

  _bucket(iccid) {
    const key = String(iccid || '').trim() || '_unknown';
    if (!this.data.byIccid[key]) {
      this.data.byIccid[key] = { outbound: [], readAt: {} };
    }
    const b = this.data.byIccid[key];
    if (!Array.isArray(b.outbound)) b.outbound = [];
    if (!b.readAt || typeof b.readAt !== 'object') b.readAt = {};
    return { key, bucket: b };
  }

  listOutbound(iccid) {
    const { bucket } = this._bucket(iccid);
    return bucket.outbound.slice();
  }

  addOutbound(iccid, { peer, body, timestamp } = {}) {
    const { key, bucket } = this._bucket(iccid);
    const peerKey = normalizePeer(peer);
    if (!peerKey) throw new Error('无效对端号码');
    const entry = {
      id: uid(),
      direction: 'out',
      peer: peerKey,
      body: String(body || ''),
      timestamp: timestamp || new Date().toISOString(),
      local: true,
    };
    bucket.outbound.push(entry);
    // Cap per ICCID
    if (bucket.outbound.length > 2000) {
      bucket.outbound.splice(0, bucket.outbound.length - 2000);
    }
    this._save();
    return { iccid: key, entry };
  }

  deleteOutbound(iccid, id) {
    const { bucket } = this._bucket(iccid);
    const before = bucket.outbound.length;
    bucket.outbound = bucket.outbound.filter((m) => m.id !== id);
    if (bucket.outbound.length !== before) this._save();
    return { deleted: before - bucket.outbound.length };
  }

  clearPeerOutbound(iccid, peer) {
    const peerKey = normalizePeer(peer);
    const { bucket } = this._bucket(iccid);
    const before = bucket.outbound.length;
    bucket.outbound = bucket.outbound.filter((m) => normalizePeer(m.peer) !== peerKey);
    if (bucket.outbound.length !== before) this._save();
    return { deleted: before - bucket.outbound.length };
  }

  markRead(iccid, peer, atMs) {
    const peerKey = normalizePeer(peer);
    if (!peerKey) return;
    const { bucket } = this._bucket(iccid);
    bucket.readAt[peerKey] = Number(atMs) || Date.now();
    this._save();
  }

  getReadAt(iccid, peer) {
    const peerKey = normalizePeer(peer);
    const { bucket } = this._bucket(iccid);
    return bucket.readAt[peerKey] || 0;
  }

  getReadMap(iccid) {
    const { bucket } = this._bucket(iccid);
    return { ...bucket.readAt };
  }
}

/**
 * Merge modem inbound PDUs with local outbound; group by normalized peer.
 */
function buildThreads(inbound, outbound, readAtMap = {}) {
  const byPeer = new Map();

  function ensure(peerRaw) {
    const peer = normalizePeer(peerRaw) || String(peerRaw || '').trim() || '(未知)';
    if (!byPeer.has(peer)) {
      byPeer.set(peer, {
        peer,
        messages: [],
        unread: 0,
        lastAt: 0,
        lastPreview: '',
      });
    }
    return byPeer.get(peer);
  }

  for (const m of inbound || []) {
    const peer = m.sender || '(未知)';
    const t = ensure(peer);
    const ts = parseTs(m.timestamp) || 0;
    const msg = {
      id: `in_${m.storage || 'SM'}_${m.index}`,
      direction: 'in',
      peer: t.peer,
      body: m.body || '',
      timestamp: m.timestamp || null,
      ts,
      storage: m.storage || 'SM',
      index: m.index,
      concat: m.concat || null,
      local: false,
    };
    t.messages.push(msg);
  }

  for (const m of outbound || []) {
    const t = ensure(m.peer);
    const ts = parseTs(m.timestamp) || 0;
    t.messages.push({
      id: m.id,
      direction: 'out',
      peer: t.peer,
      body: m.body || '',
      timestamp: m.timestamp || null,
      ts,
      local: true,
    });
  }

  const threads = [];
  for (const t of byPeer.values()) {
    t.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const last = t.messages[t.messages.length - 1];
    t.lastAt = last ? last.ts || 0 : 0;
    t.lastPreview = last ? String(last.body || '').slice(0, 80) : '';
    const readAt = Number(readAtMap[t.peer] || 0);
    t.unread = t.messages.filter((m) => m.direction === 'in' && (m.ts || 0) > readAt).length;
    threads.push(t);
  }

  threads.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return threads;
}

function parseTs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  // Modem PDU timestamp often like "26/09/23,11:52:01+32"
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const yy = 2000 + Number(m[1]);
    const mo = Number(m[2]) - 1;
    const dd = Number(m[3]);
    const hh = Number(m[4]);
    const mi = Number(m[5]);
    const ss = Number(m[6]);
    const d = new Date(yy, mo, dd, hh, mi, ss);
    const t = d.getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

module.exports = {
  SmsThreadStore,
  buildThreads,
  parseTs,
};
