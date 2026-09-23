'use strict';

const assert = require('assert');
const { normalizePeer, displayPeer, peersMatch } = require('../src/phone-normalize');
const { buildThreads } = require('../src/sms-thread-store');

assert.strictEqual(normalizePeer('13800138000'), '+8613800138000');
assert.strictEqual(normalizePeer('+8613800138000'), '+8613800138000');
assert.strictEqual(normalizePeer('8613800138000'), '+8613800138000');
assert.strictEqual(normalizePeer('013800138000'), '+8613800138000');
assert.strictEqual(normalizePeer('10086'), '10086');
assert.ok(peersMatch('13800138000', '+86 138-0013-8000'));
assert.strictEqual(displayPeer('+8613800138000'), '13800138000');

const threads = buildThreads(
  [
    { sender: '13800138000', body: 'hi', timestamp: '26/09/23,10:00:00+32', storage: 'SM', index: 1 },
    { sender: '+8613900139000', body: 'other', timestamp: '26/09/23,11:00:00+32', storage: 'SM', index: 2 },
  ],
  [
    { id: 'out_1', peer: '+8613800138000', body: 'hello', timestamp: '2026-09-23T02:05:00.000Z' },
  ],
  { '+8613800138000': 0 }
);

assert.strictEqual(threads.length, 2);
const t = threads.find((x) => x.peer === '+8613800138000');
assert.ok(t);
assert.strictEqual(t.messages.length, 2);
assert.strictEqual(t.messages[0].direction, 'in');
assert.strictEqual(t.messages[1].direction, 'out');
assert.ok(t.unread >= 1);

console.log('check-threads: ok');
