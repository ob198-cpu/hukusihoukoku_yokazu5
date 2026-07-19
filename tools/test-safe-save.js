const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let nextSheetId = 1;

class FakeRange {
  constructor(sheet, row, column, rows, columns) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rows = rows;
    this.columns = columns;
  }

  setValues(values) {
    for (let r = 0; r < this.rows; r += 1) {
      const targetRow = this.row - 1 + r;
      if (!this.sheet.rows[targetRow]) this.sheet.rows[targetRow] = [];
      for (let c = 0; c < this.columns; c += 1) {
        this.sheet.rows[targetRow][this.column - 1 + c] = values[r][c];
      }
    }
    return this;
  }

  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.columns }, (_, c) =>
        this.sheet.rows[this.row - 1 + r]?.[this.column - 1 + c] ?? ''
      )
    );
  }
}

class FakeSheet {
  constructor(book, name) {
    this.book = book;
    this.name = name;
    this.id = nextSheetId++;
    this.rows = [];
    this.maxRows = 1000;
    this.maxColumns = 26;
  }

  getName() { return this.name; }
  getSheetId() { return this.id; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if ((this.rows[i] || []).some(value => value !== '' && value !== null && value !== undefined)) return i + 1;
    }
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertRowsAfter(_after, count) { this.maxRows += count; return this; }
  insertColumnsAfter(_after, count) { this.maxColumns += count; return this; }
  appendRow(values) { this.rows.push(values.slice()); return this; }
  getRange(row, column, rows = 1, columns = 1) { return new FakeRange(this, row, column, rows, columns); }
  setFrozenRows() { return this; }
  deleteRows(start, count) { this.rows.splice(start - 1, count); return this; }
  setName(name) { this.book.renameSheet(this, name); return this; }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = new Map();
    this.failRenameTarget = '';
  }

  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error('duplicate sheet: ' + name);
    const sheet = new FakeSheet(this, name);
    this.sheets.set(name, sheet);
    return sheet;
  }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  deleteSheet(sheet) { this.sheets.delete(sheet.name); }
  renameSheet(sheet, name) {
    if (this.failRenameTarget === name) {
      this.failRenameTarget = '';
      throw new Error('simulated rename failure: ' + name);
    }
    if (this.sheets.has(name) && this.sheets.get(name) !== sheet) throw new Error('duplicate sheet: ' + name);
    this.sheets.delete(sheet.name);
    sheet.name = name;
    this.sheets.set(name, sheet);
  }
}

class FakeProperties {
  constructor() { this.values = new Map(); }
  getProperty(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setProperty(key, value) { this.values.set(key, String(value)); return this; }
  deleteProperty(key) { this.values.delete(key); return this; }
}

const book = new FakeSpreadsheet();
const properties = new FakeProperties();
let uuidCounter = 0;
const context = {
  console,
  SpreadsheetApp: { openById: () => book },
  PropertiesService: { getScriptProperties: () => properties },
  Utilities: { getUuid: () => 'uuid_' + (++uuidCounter).toString().padStart(8, '0') }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), context);

context.selectSpreadsheet_('yokazu5');
context.ensureAllSheets_();

const oldData = context.normalizeData_({
  accounts: [],
  posts: [{ id: 'old', date: '2026-07-01', sns: 'X', content: 'old', impressions: 10 }],
  history: []
});
context.commitDataSafely_(oldData, 'rev_old');
assert.equal(context.readUpdatedAt_(), 'rev_old');
assert.deepEqual(context.readData_().posts.map(item => item.id), ['old']);

const newData = context.normalizeData_({
  accounts: [],
  posts: [{ id: 'new', date: '2026-07-02', sns: 'X', content: 'new', impressions: 20 }],
  followers: [{ id: 'f1', date: '2026-07-02', sns: 'X', followers: 100 }],
  history: []
});
context.commitDataSafely_(newData, 'rev_new');
assert.equal(context.readUpdatedAt_(), 'rev_new');
assert.deepEqual(context.readData_().posts.map(item => item.id), ['new']);
assert.equal([...book.sheets.keys()].some(name => name.includes('__old_') || name.includes('__staging_')), false);

book.failRenameTarget = 'Followers';
assert.throws(() => context.commitDataSafely_(context.normalizeData_({
  posts: [{ id: 'must_not_replace', date: '2026-07-03', sns: 'X', impressions: 999 }]
}), 'rev_failed'), /simulated rename failure/);
assert.equal(context.readUpdatedAt_(), 'rev_new');
assert.deepEqual(context.readData_().posts.map(item => item.id), ['new']);
assert.equal(properties.getProperty('SNS_SAVE_TRANSACTION_yokazu5'), null);

assert.throws(() => context.saveData_(newData, 'stale_revision', 'test_client'), /CONFLICT/);
assert.equal(context.readUpdatedAt_(), 'rev_new');

const tenYears = context.normalizeData_({
  posts: Array.from({ length: 3650 }, (_, index) => ({
    id: 'p' + index,
    date: '2030-01-01',
    sns: 'X',
    content: 'post ' + index,
    impressions: index
  }))
});
context.commitDataSafely_(tenYears, 'rev_10years');
assert.equal(context.readData_().posts.length, 3650);
assert.equal(context.readUpdatedAt_(), 'rev_10years');

console.log('safe save, rollback, conflict, and 10-year volume checks passed');
