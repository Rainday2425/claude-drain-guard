'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { tapResponse } = require('../src/usageTap');

test('passive usage tap preserves response listeners and parses quota', () => {
  const response = new EventEmitter();
  let observed, bodySeen = '';
  tapResponse(response, value => { observed = value; });
  response.on('data', chunk => { bodySeen += chunk; });
  response.on('end', () => { bodySeen += '!'; });
  response.emit('data', Buffer.from('{"five_hour":{"utilization":96,"resets_at":2000000000}}'));
  response.emit('end');
  assert.match(bodySeen, /five_hour/);
  assert.ok(bodySeen.endsWith('!'));
  assert.equal(observed.utilization5h, 0.96);
});
