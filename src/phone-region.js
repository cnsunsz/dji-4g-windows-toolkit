'use strict';

/**
 * Offline Chinese mobile 归属地 lookup (province / city / carrier).
 * Uses MIT-licensed phone2region (phone.dat). Approximate; may be outdated.
 */

const { digitsOnly } = require('./phone-normalize');

let findFn = null;
try {
  const mod = require('phone2region');
  findFn = typeof mod.find === 'function' ? mod.find : mod.default;
} catch (_) {
  findFn = null;
}

/**
 * Extract an 11-digit CN mobile (1[3-9]…) for segment lookup, or null.
 * Avoids treating +1 NANP numbers as CN mobiles.
 * @param {string} raw
 * @returns {string|null}
 */
function extractCnMobile(raw) {
  const original = String(raw || '').trim();
  if (!original) return null;

  let s = digitsOnly(original);
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00') && s.length > 4) s = s.slice(2);

  // Explicit +86 / 86 prefix
  let m = s.match(/^86(1[3-9]\d{9})$/);
  if (m) return m[1];

  // Trunk 0 + CN mobile (0138…)
  m = s.match(/^0(1[3-9]\d{9})$/);
  if (m) return m[1];

  // Bare 11-digit CN mobile — only if the input did not carry another country code.
  // Any leading "+" that is not +86 was already handled above as non-86 → reject.
  if (/^1[3-9]\d{9}$/.test(s)) {
    const hadPlus = /^\s*\+/.test(original) || /^\s*00/.test(original.replace(/\s/g, ''));
    if (hadPlus) {
      // e.g. +16505550100 (NANP) — do not treat as CN
      return null;
    }
    return s;
  }

  return null;
}

/**
 * @param {string} number
 * @returns {{ text: string|null, province: string|null, city: string|null, carrier: string|null }}
 */
function lookupPhoneRegion(number) {
  const empty = { text: null, province: null, city: null, carrier: null };
  const mobile = extractCnMobile(number);
  if (!mobile || typeof findFn !== 'function') return empty;

  let info;
  try {
    info = findFn(mobile);
  } catch (_) {
    return empty;
  }
  if (!info || info.op === '异常' || !info.province) return empty;

  const province = String(info.province || '').trim() || null;
  const city = String(info.city || '').trim() || null;
  const carrier = String(info.op || '').trim() || null;
  if (!province && !carrier) return empty;

  let text;
  if (province && city && province !== city) {
    text = carrier ? `${province} ${city} ${carrier}` : `${province} ${city}`;
  } else if (province) {
    text = carrier ? `${province} ${carrier}` : province;
  } else {
    text = carrier;
  }

  return { text, province, city, carrier };
}

module.exports = {
  lookupPhoneRegion,
  extractCnMobile,
};
