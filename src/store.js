'use strict';

const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) { this.file = file; this.state = { turns: [], slices: [], offsets: {}, seen: [], groups: {}, quotaSnapshots: [] }; }
  load() {
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first run */ }
    this.state.groups ||= {};
    this.state.quotaSnapshots ||= [];
    return this.state;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state));
    fs.renameSync(temp, this.file);
  }
  addTurn(turn) {
    this.state.turns.push(turn);
    this.state.turns = this.state.turns.slice(-500);
    if (turn.id) this.state.seen = [...this.state.seen.slice(-999), turn.id];
  }
  addSlice(slice) {
    const index = this.state.slices.findIndex(item => item.start === slice.start);
    if (index >= 0) this.state.slices[index] = slice; else this.state.slices.push(slice);
    this.state.slices = this.state.slices.sort((a, b) => a.start - b.start).slice(-288);
  }
}

module.exports = { Store };
