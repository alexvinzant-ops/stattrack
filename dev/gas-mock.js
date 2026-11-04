// Minimal in-memory stand-ins for the Google Apps Script services Code.gs uses,
// so the backend can be unit-tested and run locally. Not used in production.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v == null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some(r => r.length !== this.numCols)) {
      throw new Error(`setValues: data is ${values.length}x${values[0] && values[0].length}, range is ${this.numRows}x${this.numCols}`);
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => {
        // Sheets stores plain values; mimic JSON-ish storage.
        this.sheet.data[idx][this.col - 1 + c] = v instanceof Date ? v.toISOString() : v;
      });
    });
    this.sheet.changed();
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.data[this.row - 1 + r];
      if (!line) continue;
      for (let c = 0; c < this.numCols; c++) line[this.col - 1 + c] = '';
    }
    this.sheet.changed();
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class MockSheet {
  constructor(name, data, onChange) {
    this.name = name;
    this.data = data || [];
    this.onChange = onChange;
  }
  changed() { this.onChange && this.onChange(); }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) {
      if ((this.data[i] || []).some(v => v !== '' && v != null)) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    return this.data.reduce((m, r) => Math.max(m, (r || []).length), 0);
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('Bad range');
    return new MockRange(this, row, col, numRows, numCols);
  }
  setFrozenRows() { return this; }
  deleteRow(row) { this.data.splice(row - 1, 1); this.changed(); }
  clear() { this.data.length = 0; this.changed(); return this; }
}

function createGas(opts = {}) {
  const file = opts.file;
  let saved = {};
  if (file && fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sheets = {};
  const persist = () => {
    if (!file) return;
    const out = {};
    Object.values(sheets).forEach(s => { out[s.name] = s.data; });
    fs.writeFileSync(file, JSON.stringify(out));
  };
  Object.keys(saved).forEach(n => { sheets[n] = new MockSheet(n, saved[n], persist); });

  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => {
      if (sheets[n]) throw new Error('Sheet exists: ' + n);
      sheets[n] = new MockSheet(n, [], persist);
      persist();
      return sheets[n];
    },
    getUrl: () => 'https://docs.google.com/spreadsheets/d/mock',
    getSpreadsheetTimeZone: () => 'America/Los_Angeles',
  };

  const cache = new Map();
  const context = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: k => { cache.delete(k); },
      }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
      formatDate: d => d.toISOString().slice(0, 10),
    },
    Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
    ScriptApp: { getService: () => ({ getUrl: () => opts.appUrl || 'http://localhost:8080' }) },
    HtmlService: {
      createHtmlOutputFromFile: () => {
        const o = { setTitle: () => o, addMetaTag: () => o };
        return o;
      },
    },
    Logger: { log: (...a) => console.log(...a) },
  };
  vm.createContext(context);
  const codePath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });
  return {
    context,
    sheets,
    cache,
    // Simulate Apps Script's JSON-ish serialization in both directions.
    api: req => JSON.parse(JSON.stringify(context.api(JSON.parse(JSON.stringify(req))))),
  };
}

module.exports = { createGas };
