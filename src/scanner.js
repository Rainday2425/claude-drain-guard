'use strict';

const fs = require('fs');
const path = require('path');

async function recentJsonl(root, cutoff = Date.now() - 48 * 60 * 60_000) {
  const result = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) {
        try { if ((await fs.promises.stat(full)).mtimeMs >= cutoff) result.push(full); } catch {}
      }
    }
  }
  return result;
}

async function readJsonlIncrement(file, previousOffset, onEntry, highWaterMark = 256 * 1024) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { offset: previousOffset, processed: 0, missing: true }; }
  let offset = stat.size < previousOffset ? 0 : previousOffset;
  if (stat.size === offset) return { offset, processed: 0, missing: false };

  const stream = fs.createReadStream(file, { start: offset, end: stat.size - 1, highWaterMark });
  let parts = [], pendingLength = 0, committed = offset, processed = 0;
  for await (const chunk of stream) {
    let cursor = 0, newline;
    while ((newline = chunk.indexOf(0x0a, cursor)) >= 0) {
      const finalPart = chunk.subarray(cursor, newline);
      const lineBuffer = pendingLength ? Buffer.concat([...parts, finalPart], pendingLength + finalPart.length) : finalPart;
      const line = lineBuffer.toString('utf8').replace(/\r$/, '');
      committed += lineBuffer.length + 1;
      parts = [];
      pendingLength = 0;
      cursor = newline + 1;
      if (!line.trim()) continue;
      try { if (onEntry(JSON.parse(line))) processed++; } catch { /* malformed complete line: skip */ }
    }
    if (cursor < chunk.length) {
      const remainder = chunk.subarray(cursor);
      parts.push(remainder);
      pendingLength += remainder.length;
    }
  }

  if (pendingLength) {
    const tail = Buffer.concat(parts, pendingLength).toString('utf8').replace(/\r$/, '');
    try { if (onEntry(JSON.parse(tail))) processed++; committed = stat.size; } catch { /* incomplete tail: retry later */ }
  } else committed = stat.size;
  return { offset: committed, processed, missing: false };
}

module.exports = { recentJsonl, readJsonlIncrement };
