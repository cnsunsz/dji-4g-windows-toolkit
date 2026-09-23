'use strict';

/**
 * Tiny self-check: SMS-SUBMIT TPDU must be FO + MR + …
 * Run: npm run check:pdu
 */
const { encodeSubmitPdu, encodeAddress, hexToBuf } = require('../src/pdu');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cases = [
  { to: '+8613800138000', text: 'hi' },
  { to: '8613800138000', text: '测试' },
  { to: '13800138000', text: 'A' },
];

for (const c of cases) {
  const { pduHex, tpduLen } = encodeSubmitPdu(c.to, c.text);
  const buf = hexToBuf(pduHex);
  const scaLen = buf[0];
  const tpduOff = 1 + scaLen;
  const tpdu = buf.subarray(tpduOff);
  assert(tpdu.length === tpduLen, `tpduLen mismatch for ${c.to}`);
  assert((tpdu[0] & 0x03) === 0x01, `FO MTI not SMS-SUBMIT for ${c.to}`);
  assert(tpdu[1] === 0x00, `MR missing/wrong after FO for ${c.to}`);
}

const intl = encodeAddress('8613800138000');
assert(intl[1] === 0x91, '86########## should use type 0x91');
const plus = encodeAddress('+8613800138000');
assert(plus[1] === 0x91, '+86… should use type 0x91');

console.log('check-pdu: OK (FO,MR present; tpduLen includes MR; 86… → 0x91)');
