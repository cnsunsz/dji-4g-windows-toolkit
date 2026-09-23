'use strict';

/**
 * Minimal MIT-clean GSM SMS PDU helpers (3GPP TS 23.040 / 27.005 style).
 * Original implementation for this toolkit — not derived from PolyForm sources.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const GSM7_EXT = {
  '\f': 0x0a,
  '^': 0x14,
  '{': 0x28,
  '}': 0x29,
  '\\': 0x2f,
  '[': 0x3c,
  '~': 0x3d,
  ']': 0x3e,
  '|': 0x40,
  '€': 0x65,
};

const GSM7_EXT_REV = Object.fromEntries(
  Object.entries(GSM7_EXT).map(([ch, code]) => [code, ch])
);

function hexToBuf(hex) {
  const compact = String(hex || '')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!compact || compact.length % 2 !== 0 || !/^[0-9A-F]+$/.test(compact)) {
    throw new Error('Invalid PDU hex');
  }
  return Buffer.from(compact, 'hex');
}

function bufToHex(buf) {
  return Buffer.from(buf).toString('hex').toUpperCase();
}

function decodeSemiOctets(buf, digitCount) {
  let out = '';
  for (let i = 0; i < buf.length && out.length < digitCount; i++) {
    const lo = buf[i] & 0x0f;
    const hi = (buf[i] >> 4) & 0x0f;
    if (out.length < digitCount) out += nibbleToDigit(lo);
    if (out.length < digitCount && hi !== 0x0f) out += nibbleToDigit(hi);
  }
  return out;
}

function nibbleToDigit(n) {
  if (n <= 9) return String(n);
  return '0123456789ABCDEF'[n] || '?';
}

function encodeSemiOctets(digits) {
  const clean = String(digits || '').replace(/\D/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    const lo = parseInt(clean[i], 10);
    const hi = i + 1 < clean.length ? parseInt(clean[i + 1], 10) : 0x0f;
    bytes.push((hi << 4) | lo);
  }
  return { digits: clean, buf: Buffer.from(bytes) };
}

function decodeAddress(buf, offset) {
  if (offset >= buf.length) throw new Error('Truncated address');
  const digitCount = buf[offset];
  const type = buf[offset + 1];
  const octetLen = Math.ceil(digitCount / 2);
  const addrBuf = buf.subarray(offset + 2, offset + 2 + octetLen);
  if (addrBuf.length < octetLen) throw new Error('Truncated address digits');
  let number = decodeSemiOctets(addrBuf, digitCount);
  const ton = (type >> 4) & 0x07;
  if (ton === 1) number = '+' + number; // international
  return {
    length: 2 + octetLen,
    type,
    number,
  };
}

function encodeAddress(number) {
  let n = String(number || '').trim();
  let type = 0x81; // unknown / national
  if (n.startsWith('+')) {
    type = 0x91;
    n = n.slice(1);
  }
  n = n.replace(/\D/g, '');
  const { digits, buf } = encodeSemiOctets(n);
  return Buffer.concat([Buffer.from([digits.length, type]), buf]);
}

function decodeScts(buf) {
  if (buf.length < 7) return '';
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const b = buf[i];
    const swapped = ((b & 0x0f) << 4) | ((b >> 4) & 0x0f);
    parts.push(swapped);
  }
  const yy = parts[0];
  const mo = parts[1];
  const dd = parts[2];
  const hh = parts[3];
  const mi = parts[4];
  const ss = parts[5];
  const tzByte = parts[6];
  const tzSign = tzByte & 0x08 ? -1 : 1;
  const tzQuarters = ((tzByte & 0x07) * 10 + ((tzByte >> 4) & 0x0f)) * tzSign;
  const tzHours = Math.trunc(tzQuarters / 4);
  const tzMins = Math.abs(tzQuarters % 4) * 15;
  const tz =
    (tzQuarters >= 0 ? '+' : '-') +
    String(Math.abs(tzHours)).padStart(2, '0') +
    String(tzMins).padStart(2, '0');
  const year = 2000 + (yy % 100);
  return `${year}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(ss).padStart(2, '0')} GMT${tz}`;
}

function unpackGsm7(data, septetCount, skipSeptets = 0) {
  const outCodes = [];
  let bitOffset = skipSeptets * 7;
  for (let i = 0; i < septetCount; i++) {
    const byteIndex = Math.floor(bitOffset / 8);
    const bitIndex = bitOffset % 8;
    if (byteIndex >= data.length) break;
    let value = data[byteIndex] >> bitIndex;
    if (bitIndex > 1) {
      if (byteIndex + 1 < data.length) {
        value |= data[byteIndex + 1] << (8 - bitIndex);
      }
    }
    outCodes.push(value & 0x7f);
    bitOffset += 7;
  }
  let text = '';
  for (let i = 0; i < outCodes.length; i++) {
    const c = outCodes[i];
    if (c === 0x1b && i + 1 < outCodes.length) {
      const ext = GSM7_EXT_REV[outCodes[i + 1]];
      text += ext != null ? ext : '';
      i++;
    } else {
      text += GSM7_BASIC[c] != null ? GSM7_BASIC[c] : '?';
    }
  }
  return text;
}

function packGsm7(text) {
  const septets = [];
  for (const ch of text) {
    const idx = GSM7_BASIC.indexOf(ch);
    if (idx >= 0) {
      septets.push(idx);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(GSM7_EXT, ch)) {
      septets.push(0x1b, GSM7_EXT[ch]);
      continue;
    }
    return null; // not GSM7
  }
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const s of septets) {
    acc |= (s & 0x7f) << bits;
    bits += 7;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) bytes.push(acc & 0xff);
  return { septets: septets.length, buf: Buffer.from(bytes) };
}

function decodeUcs2(buf) {
  try {
    return Buffer.from(buf).swap16().toString('utf16le');
  } catch {
    return buf.toString('hex');
  }
}

function encodeUcs2(text) {
  return Buffer.from(text, 'utf16le').swap16();
}

function dcsIsUcs2(dcs) {
  return (dcs & 0x0c) === 0x08;
}

function dcsIs8Bit(dcs) {
  return (dcs & 0x0c) === 0x04;
}

/**
 * Decode SMS-DELIVER PDU (hex string including SCA).
 * Returns { sender, timestamp, body, dcs, concat?, raw }
 */
function decodeDeliverPdu(hex) {
  const buf = hexToBuf(hex);
  let o = 0;
  const scaLen = buf[o++];
  if (scaLen > 0) {
    o += scaLen; // skip SCA (length includes type octet)
  }
  if (o >= buf.length) throw new Error('Empty TPDU');
  const fo = buf[o++];
  const mti = fo & 0x03;
  const udhi = !!(fo & 0x40);
  if (mti !== 0) {
    // Not DELIVER — still try best-effort for status reports etc.
  }
  const oa = decodeAddress(buf, o);
  o += oa.length;
  const pid = buf[o++];
  const dcs = buf[o++];
  const scts = buf.subarray(o, o + 7);
  o += 7;
  const timestamp = decodeScts(scts);
  const udl = buf[o++];
  const ud = buf.subarray(o);
  let body = '';
  let concat = null;
  let headerSeptets = 0;
  let udhLen = 0;
  let userData = ud;

  if (udhi && ud.length > 0) {
    udhLen = ud[0] + 1; // include length byte
    const udh = ud.subarray(0, udhLen);
    userData = ud.subarray(udhLen);
    // parse IE for concat
    let i = 1;
    while (i < udh.length) {
      const iei = udh[i++];
      if (i >= udh.length) break;
      const iedl = udh[i++];
      const ied = udh.subarray(i, i + iedl);
      i += iedl;
      if (iei === 0x00 && iedl >= 3) {
        concat = { ref: ied[0], total: ied[1], seq: ied[2], bits: 8 };
      } else if (iei === 0x08 && iedl >= 4) {
        concat = { ref: (ied[0] << 8) | ied[1], total: ied[2], seq: ied[3], bits: 16 };
      }
    }
    if (!dcsIsUcs2(dcs) && !dcsIs8Bit(dcs)) {
      headerSeptets = Math.ceil((udhLen * 8) / 7);
    }
  }

  if (dcsIsUcs2(dcs)) {
    const bytes = udhi ? userData : ud.subarray(0, udl);
    body = decodeUcs2(bytes);
  } else if (dcsIs8Bit(dcs)) {
    const bytes = udhi ? userData : ud.subarray(0, udl);
    body = bytes.toString('latin1');
  } else {
    // GSM 7-bit: udl is septet count
    body = unpackGsm7(ud, udl, headerSeptets);
  }

  return {
    sender: oa.number,
    timestamp,
    body,
    dcs,
    pid,
    udhi,
    concat,
    mti,
    raw: bufToHex(buf),
  };
}

/**
 * Build SMS-SUBMIT PDU (with default SCA 00).
 * Returns { pduHex, tpduLen } where tpduLen is for AT+CMGS.
 */
function encodeSubmitPdu(recipient, text, { statusReport = false } = {}) {
  const sca = Buffer.from([0x00]);
  let fo = 0x01; // SMS-SUBMIT, no VP relative in FO yet — use relative VP → bit4=1 → 0x11
  fo = 0x11; // MTI=01, VPF=relative
  if (statusReport) fo |= 0x20;

  const da = encodeAddress(recipient);
  const pid = Buffer.from([0x00]);
  const packed = packGsm7(text);
  let dcs;
  let ud;
  let udl;

  if (packed && packed.septets <= 160) {
    dcs = Buffer.from([0x00]);
    udl = Buffer.from([packed.septets]);
    ud = packed.buf;
  } else {
    const ucs = encodeUcs2(text);
    if (ucs.length > 140) {
      throw new Error('短信过长（PDU 单条 UCS2 最多 70 字）');
    }
    dcs = Buffer.from([0x08]);
    udl = Buffer.from([ucs.length]);
    ud = ucs;
  }

  const vp = Buffer.from([0xaa]); // relative VP ~ 4 days (common default)
  const tpdu = Buffer.concat([Buffer.from([fo]), da, pid, dcs, vp, udl, ud]);
  const pdu = Buffer.concat([sca, tpdu]);
  return { pduHex: bufToHex(pdu), tpduLen: tpdu.length };
}

/**
 * Parse AT+CMGL PDU-mode listing (+CMGL: idx,stat,,len \\n PDU).
 */
function parseCmglPdu(response) {
  const messages = [];
  const lines = String(response || '')
    .replace(/\r/g, '')
    .split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(/^\+CMGL:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const fields = m[1].split(',').map((s) => s.trim());
    const index = fields[0] ? parseInt(fields[0], 10) : null;
    const status = (fields[1] || '').replace(/^"|"$/g, '');
    i++;
    // skip blank lines; next non-empty should be PDU hex
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const pduLine = lines[i].trim();
    i++;
    if (!/^[0-9A-Fa-f]+$/.test(pduLine)) continue;
    try {
      const decoded = decodeDeliverPdu(pduLine);
      messages.push({
        index: Number.isFinite(index) ? index : null,
        status,
        sender: decoded.sender,
        timestamp: decoded.timestamp,
        body: decoded.body,
        storage: null,
        concat: decoded.concat,
        pdu: pduLine,
      });
    } catch (err) {
      messages.push({
        index: Number.isFinite(index) ? index : null,
        status,
        sender: '',
        timestamp: '',
        body: `[PDU decode error: ${err.message}]`,
        storage: null,
        concat: null,
        pdu: pduLine,
      });
    }
  }
  return messages;
}

/**
 * Parse AT+CMGR PDU-mode response.
 */
function parseCmgrPdu(response) {
  const lines = String(response || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let pdu = null;
  let status = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\+CMGR:\s*(.*)$/);
    if (m) {
      const fields = m[1].split(',').map((s) => s.trim());
      status = (fields[0] || '').replace(/^"|"$/g, '');
      if (i + 1 < lines.length && /^[0-9A-Fa-f]+$/.test(lines[i + 1])) {
        pdu = lines[i + 1];
      }
      break;
    }
  }
  if (!pdu) return null;
  const decoded = decodeDeliverPdu(pdu);
  return {
    status,
    sender: decoded.sender,
    timestamp: decoded.timestamp,
    body: decoded.body,
    concat: decoded.concat,
    pdu,
  };
}

/**
 * Reassemble concatenated parts when all segments present.
 * messages: array with optional .concat {ref,total,seq}
 */
function reassembleConcat(messages) {
  const groups = new Map();
  const singles = [];
  for (const msg of messages) {
    if (!msg.concat || !msg.concat.total || msg.concat.total <= 1) {
      singles.push(msg);
      continue;
    }
    const key = `${msg.sender || ''}|${msg.concat.ref}|${msg.concat.total}|${msg.concat.bits || 8}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  }
  const out = [...singles];
  for (const [, parts] of groups) {
    const total = parts[0].concat.total;
    const bySeq = new Map();
    for (const p of parts) {
      bySeq.set(p.concat.seq, p);
    }
    if (bySeq.size >= total) {
      const ordered = [];
      for (let s = 1; s <= total; s++) {
        const p = bySeq.get(s);
        if (!p) {
          ordered.length = 0;
          break;
        }
        ordered.push(p);
      }
      if (ordered.length === total) {
        out.push({
          index: ordered.map((p) => p.index).filter((x) => x != null).join('+'),
          status: ordered[0].status,
          sender: ordered[0].sender,
          timestamp: ordered[0].timestamp,
          body: ordered.map((p) => p.body).join(''),
          storage: ordered[0].storage,
          concat: { ...ordered[0].concat, reassembled: true },
          pdu: null,
        });
        continue;
      }
    }
    // incomplete — keep parts
    out.push(...parts);
  }
  // sort by timestamp/index roughly
  out.sort((a, b) => {
    const ta = String(a.timestamp || '');
    const tb = String(b.timestamp || '');
    if (ta !== tb) return ta < tb ? 1 : -1;
    return String(a.index) < String(b.index) ? 1 : -1;
  });
  return out;
}

function canEncodeGsm7(text) {
  return packGsm7(text) != null;
}

module.exports = {
  decodeDeliverPdu,
  encodeSubmitPdu,
  parseCmglPdu,
  parseCmgrPdu,
  reassembleConcat,
  canEncodeGsm7,
  packGsm7,
  unpackGsm7,
  hexToBuf,
  bufToHex,
};
