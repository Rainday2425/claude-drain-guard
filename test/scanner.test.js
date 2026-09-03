'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recentJsonl, readJsonlIncrement } = require('../src/scanner');
const { Store } = require('../src/store');

test('incremental scanner commits CRLF bytes and preserves an incomplete tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-'));
  const file = path.join(dir, 'session.jsonl');
  const first = '{"id":1,"text":"héllo"}\r\n\r\n';
  const partial = '{"id":2';
  fs.writeFileSync(file, first + partial);
  const entries = [];
  const one = await readJsonlIncrement(file, 0, entry => entries.push(entry), 5);
  assert.deepEqual(entries, [{ id: 1, text: 'héllo' }]);
  assert.equal(one.offset, Buffer.byteLength(first));
  assert.ok(one.mtimeMs > 0);
  fs.appendFileSync(file, '}\n');
  const two = await readJsonlIncrement(file, one.offset, entry => entries.push(entry), 3);
  assert.deepEqual(entries.at(-1), { id: 2 });
  assert.equal(two.offset, fs.statSync(file).size);
});

test('discovery returns only recent JSONL files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-'));
  const nested = path.join(dir, 'project');
  fs.mkdirSync(nested);
  const jsonl = path.join(nested, 'active.jsonl');
  fs.writeFileSync(jsonl, '{}\n');
  fs.writeFileSync(path.join(nested, 'ignore.txt'), '{}\n');
  assert.deepEqual(await recentJsonl(dir, Date.now() - 60_000), [jsonl]);
});

test('scheduled store writes are coalesced and atomic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-'));
  const file = path.join(dir, 'metrics.json');
  const store = new Store(file);
  store.state.turns.push({ id: 1 });
  store.scheduleSave(10);
  store.state.turns.push({ id: 2 });
  store.scheduleSave(10);
  await new Promise(resolve => setTimeout(resolve, 40));
  await store.writeChain;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).turns.map(item => item.id), [1, 2]);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
