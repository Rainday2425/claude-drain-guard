'use strict';

const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    this.state = { turns: [], slices: [], offsets: {}, seen: [], groups: {}, quotaSnapshots: [], detectorVersion: 0 };
    this.saveTimer = null;
    this.writeChain = Promise.resolve();
  }
  load() {
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first run */ }
    this.state.groups ||= {};
    this.state.quotaSnapshots ||= [];
    return this.state;
  }
  scheduleSave(delay = 750) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.save().catch(() => {}); }, delay);
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fs.promises.writeFile(temp, snapshot);
      await fs.promises.rename(temp, this.file);
    });
    return this.writeChain;
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
