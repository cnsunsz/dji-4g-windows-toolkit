'use strict';

/**
 * Normalize peer phone numbers for SMS thread keys.
 * CN mobiles: strip leading 0, map 1[3-9]xxxxxxxxx → +86…; keep +86 / 86 prefixes consistent.
 */

function digitsOnly(s) {
  return String(s || '').replace(/[^\d+]/g, '');
}

function normalizePeer(raw) {
  let s = digitsOnly(raw).trim();
  if (!s) return '';

  if (s.startsWith('+')) s = s.slice(1);

  // 0086… → 86…
  if (s.startsWith('00') && s.length > 4) s = s.slice(2);

  // Strip trunk 0 before CN mobile (0138… / 0-138…)
  if (/^0\d{10,}$/.test(s)) s = s.replace(/^0+/, '');

  // 86 + 11-digit CN mobile
  if (/^86(1[3-9]\d{9})$/.test(s)) {
    return `+${s}`;
  }

  // Bare CN mobile
  if (/^1[3-9]\d{9}$/.test(s)) {
    return `+86${s}`;
  }

  // Other international / short codes (10086, etc.)
  if (/^\d{3,15}$/.test(s)) {
    // Keep short service numbers without forcing +86
    if (s.length <= 6) return s;
    return `+${s}`;
  }

  return s ? `+${s}` : '';
}

/** Display-friendly: +86138… → 138… (CN) or keep E.164 */
function displayPeer(raw) {
  const n = normalizePeer(raw) || String(raw || '').trim() || '(未知)';
  const m = n.match(/^\+86(1[3-9]\d{9})$/);
  if (m) return m[1];
  if (n.startsWith('+')) return n;
  return n;
}

function peersMatch(a, b) {
  const na = normalizePeer(a);
  const nb = normalizePeer(b);
  if (!na || !nb) return false;
  return na === nb;
}

module.exports = {
  normalizePeer,
  displayPeer,
  peersMatch,
  digitsOnly,
};
