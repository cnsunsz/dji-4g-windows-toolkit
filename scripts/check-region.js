'use strict';

const assert = require('assert');
const { lookupPhoneRegion, extractCnMobile } = require('../src/phone-region');
const { displayPeer } = require('../src/phone-normalize');

assert.strictEqual(extractCnMobile('+8613901234567'), '13901234567');
assert.strictEqual(extractCnMobile('13901234567'), '13901234567');
assert.strictEqual(extractCnMobile('+1 650 555 0100'), null);
assert.strictEqual(extractCnMobile('+16505550100'), null);

const r1 = lookupPhoneRegion('13912345678');
assert.ok(r1.text && r1.text.includes('江苏'), JSON.stringify(r1));
assert.ok(r1.carrier);

const r2 = lookupPhoneRegion('+8618600000000');
assert.ok(r2.text && r2.text.includes('北京'), JSON.stringify(r2));

const r3 = lookupPhoneRegion('+447911123456');
assert.strictEqual(r3.text, null);

assert.strictEqual(displayPeer('+8613800138000'), '13800138000');
assert.ok(displayPeer('+8613800138000').length === 11);

console.log('check:region OK', r1.text, r2.text);
