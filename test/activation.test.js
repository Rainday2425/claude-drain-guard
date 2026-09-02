'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

test('activation immediately renders non-empty right-side status items', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-activation-'));
  const items = [];
  const mockVscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => key === 'dataDirectory' ? directory : fallback,
        update: async () => {}
      }),
      openTextDocument: async () => ({})
    },
    window: {
      createStatusBarItem: (alignment) => {
        const item = { alignment, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
        items.push(item);
        return item;
      },
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showTextDocument: async () => undefined
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? mockVscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    const extension = require('../src/extension');
    const context = { globalStorageUri: { fsPath: path.join(directory, 'state') }, subscriptions: [] };
    extension.activate(context);
    assert.equal(items.length, 2);
    assert.equal(items.every(item => item.alignment === mockVscode.StatusBarAlignment.Right), true);
    assert.equal(items.every(item => item.visible && item.text), true);
    assert.equal(items[0].text, '5h — · cache —');
    for (const disposable of context.subscriptions) disposable.dispose?.();
    await extension.deactivate();
  } finally {
    Module._load = originalLoad;
  }
});
