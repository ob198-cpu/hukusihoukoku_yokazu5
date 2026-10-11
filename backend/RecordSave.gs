// Only yokazu5 participates in the pilot. Legacy clients keep their revision checks.
const RECORD_SAVE_VERSION = 1;
const RECORD_TRANSACTION_PREFIX = 'SNS_RECORD_TRANSACTION_';

function recordSaveSupported_() { return ACTIVE_SYSTEM_KEY === 'yokazu5'; }

function readRecordData_() {
  const data = readData_();
  data.history.sort(function(a, b) { return String(b.at).localeCompare(String(a.at)); });
  return data;
}

function saveChanges_(request) {
  if (!recordSaveSupported_() || request.protocolVersion !== RECORD_SAVE_VERSION
      || request.spreadsheetId !== ACTIVE_SPREADSHEET_ID
      || request.systemKey !== ACTIVE_SYSTEM_KEY || typeof request.requestId !== 'string'
      || !request.requestId || request.requestId.length > 200) {
    throw new Error('RECORD_SAVE_TARGET_MISMATCH: 保存先・送信方式を確認してください。');
  }
  const current = readData_();
  const next = SnsRecordSync.apply(current, request.changes);
  const effective = request.changes.filter(function(change) {
    return !SnsRecordSync.verify(current, [change]);
  });
  let updatedAt = readUpdatedAt_();
  if (effective.length) {
    updatedAt = new Date().toISOString() + '#' + Utilities.getUuid().slice(0, 8);
    const writes = recordWrites_(current, next, effective, updatedAt);
    commitRecordWrites_(writes);
  }
  const confirmed = readRecordData_();
  if (!SnsRecordSync.verify(confirmed, request.changes)) {
    throw new Error('RECORD_READBACK_MISMATCH: シートの読戻し内容が一致しません。');
  }
  // Optional history/backups never decide whether the business write succeeded.
  try {
    appendSyncHistory_('records-saved', request.expectedUpdatedAt || '', '', updatedAt,
      confirmed, request.clientId || '');
  } catch (error) {
    console.error('SyncHistory write failed: ' + error.message);
  }
  return {data: confirmed, updatedAt: updatedAt, systemKey: ACTIVE_SYSTEM_KEY,
    spreadsheetId: ACTIVE_SPREADSHEET_ID, backendBuildId: BACKEND_BUILD_ID,
    recordSaveVersion: RECORD_SAVE_VERSION, requestId: request.requestId, verified: true};
}

function recordCellSnapshot_(range) {
  const values = range.getValues()[0].map(function(value) {
    return value instanceof Date ? {date: value.toISOString()} : value;
  });
  return {values: values, formulas: range.getFormulas()[0]};
}

function recordCellsEqual_(actual, expected, write) {
  if (!SnsRecordSync.equal(actual.formulas, expected.formulas)
      || actual.values.length !== expected.values.length) return false;
  const def = Object.keys(SHEETS).map(function(key) { return SHEETS[key]; })
    .find(function(item) { return item.name === write.name; });
  return actual.values.every(function(value, i) {
    const wanted = expected.values[i];
    if (SnsRecordSync.equal(value, wanted)) return true;
    // Sheets converts date/time input to Date without changing its displayed value.
    const date = value && value.date ? value : wanted && wanted.date ? wanted : null;
    const text = date === value ? wanted : value;
    const header = def && def.headers[i];
    if (!date || typeof text !== 'string') return false;
    let input, format;
    if (['date', 'weekStart', 'weekEnd', 'checkDate'].indexOf(header) >= 0
        && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      input = text; format = 'yyyy-MM-dd';
    } else if (header === 'postTime' && /^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
      input = '1899-12-30 ' + text; format = text.length === 5 ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd HH:mm:ss';
    } else return false;
    const timezone = targetSpreadsheet_().getSpreadsheetTimeZone() || 'Etc/GMT';
    const parsed = Utilities.parseDate(input, timezone, format);
    return Utilities.formatDate(parsed, timezone, format) === input && parsed.toISOString() === date.date;
  });
}

function writeRecordCells_(range, cells) {
  range.setValues([cells.values.map(function(value, i) {
    return cells.formulas[i] || (value && typeof value === 'object' && value.date
      ? new Date(value.date) : value);
  })]);
}

function recordWrites_(current, next, changes, updatedAt) {
  const ss = targetSpreadsheet_();
  const mappers = {posts: postRow_, workMetrics: workMetricRow_, followers: followerRow_,
    inquiries: inquiryRow_, lsteps: lstepRow_, monitoring: monitoringRow_, agencyNotices: agencyNoticeRow_,
    history: function(item) { return historyRows_([item])[0]; }};
  const appends = {};
  const writes = [];
  changes.forEach(function(change) {
    if (change.collection === 'accounts') return;
    const def = SHEETS[change.collection];
    const sheet = ss.getSheetByName(def.name);
    const rows = readRawRows_(def);
    const id = (change.after || change.before).id;
    const matches = [];
    rows.forEach(function(row, i) { if (String(row[0]) === String(id)) matches.push(i + 2); });
    if (matches.length > 1) throw new Error('DUPLICATE_ID: ' + def.name);
    const existing = (current[change.collection] || []).find(function(item) {
      return SnsRecordSync.key(change.collection, item) === change.key;
    });
    if (Boolean(existing) !== Boolean(matches.length)) {
      throw new Error('ROW_ID_MISMATCH: ' + def.name + ' のID列と保存内容の確認が必要です。');
    }
    let row = matches[0];
    if (!row) {
      if (!appends[def.name]) appends[def.name] = sheet.getLastRow() + 1;
      row = appends[def.name]++;
    }
    const width = def.headers.length;
    const empty = {values: Array(width).fill(''), formulas: Array(width).fill('')};
    const before = row <= sheet.getMaxRows()
      ? recordCellSnapshot_(sheet.getRange(row, 1, 1, width)) : empty;
    const values = change.after ? mappers[change.collection](change.after) : empty.values;
    writes.push({name: def.name, row: row, width: width, before: before,
      after: {values: values, formulas: Array(width).fill('')}});
  });
  const state = ss.getSheetByName(SHEETS.state.name);
  const stateRows = readRawRows_(SHEETS.state);
  const matches = stateRows.map(function(row, i) { return row[0] === 'data' ? i + 2 : 0; }).filter(Boolean);
  if (matches.length > 1) throw new Error('DUPLICATE_STATE');
  const stateRow = matches[0] || state.getLastRow() + 1;
  const metadata = Object.assign({}, readState_(), {accounts: next.accounts || [], savedAt: updatedAt});
  writes.push({name: SHEETS.state.name, row: stateRow, width: 3,
    before: recordCellSnapshot_(state.getRange(stateRow, 1, 1, 3)),
    after: {values: ['data', JSON.stringify(metadata), updatedAt], formulas: ['', '', '']}});
  return writes;
}

function recordTransactionKey_() { return RECORD_TRANSACTION_PREFIX + ACTIVE_SYSTEM_KEY; }

function recordJournalDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function commitRecordWrites_(writes) {
  const ss = targetSpreadsheet_();
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(recordTransactionKey_())) throw new Error('RECORD_TRANSACTION_PENDING');
  const text = JSON.stringify({systemKey: ACTIVE_SYSTEM_KEY, spreadsheetId: ACTIVE_SPREADSHEET_ID, writes: writes});
  const name = '__record_tx_' + Utilities.getUuid().replace(/-/g, '');
  const journal = ss.insertSheet(name);
  const chunks = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 30000, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xD800 && code <= 0xDBFF) end -= 1;
    chunks.push(['j:' + text.slice(offset, end)]);
    offset = end;
  }
  if (journal.getMaxRows() < chunks.length) journal.insertRowsAfter(journal.getMaxRows(), chunks.length - journal.getMaxRows());
  journal.getRange(1, 1, chunks.length, 1).setValues(chunks);
  SpreadsheetApp.flush();
  const reread = journal.getRange(1, 1, chunks.length, 1).getValues().map(function(row) { return String(row[0]).slice(2); }).join('');
  if (reread !== text) throw new Error('RECORD_JOURNAL_READBACK_FAILED');
  const transaction = {name: name, digest: recordJournalDigest_(text), phase: 'prepared', rows: chunks.length};
  // This journal provides transaction rollback, not optional backup history.
  properties.setProperty(recordTransactionKey_(), JSON.stringify(transaction));
  try {
    writes.forEach(function(write) {
      const sheet = ss.getSheetByName(write.name);
      if (sheet.getMaxRows() < write.row) sheet.insertRowsAfter(sheet.getMaxRows(), write.row - sheet.getMaxRows());
      writeRecordCells_(sheet.getRange(write.row, 1, 1, write.width), write.after);
    });
    SpreadsheetApp.flush();
    writes.forEach(function(write) {
      const actual = recordCellSnapshot_(ss.getSheetByName(write.name).getRange(write.row, 1, 1, write.width));
      if (!recordCellsEqual_(actual, write.after, write)) throw new Error('RECORD_CELL_READBACK_MISMATCH');
    });
    transaction.phase = 'committed';
    properties.setProperty(recordTransactionKey_(), JSON.stringify(transaction));
  } catch (error) {
    try { recoverRecordSave_(); } catch (recoveryError) {
      console.error('Record recovery requires review: ' + recoveryError.message);
    }
    throw error;
  }
  // Cleanup failure cannot turn a verified save into a reported failure.
  try { recoverRecordSave_(); } catch (error) { console.error('Record cleanup pending: ' + error.message); }
}

function recoverRecordSave_() {
  const properties = PropertiesService.getScriptProperties();
  const raw = properties.getProperty(recordTransactionKey_());
  if (!raw) return;
  const transaction = JSON.parse(raw);
  const ss = targetSpreadsheet_();
  const journal = ss.getSheetByName(transaction.name);
  if (!journal) throw new Error('RECORD_JOURNAL_MISSING');
  const text = journal.getRange(1, 1, transaction.rows, 1).getValues().map(function(row) {
    if (String(row[0]).slice(0, 2) !== 'j:') throw new Error('RECORD_JOURNAL_CORRUPT');
    return String(row[0]).slice(2);
  }).join('');
  if (recordJournalDigest_(text) !== transaction.digest) throw new Error('RECORD_JOURNAL_CORRUPT');
  const saved = JSON.parse(text);
  if (saved.systemKey !== ACTIVE_SYSTEM_KEY || saved.spreadsheetId !== ACTIVE_SPREADSHEET_ID) {
    throw new Error('RECORD_JOURNAL_WRONG_OFFICE');
  }
  if (transaction.phase === 'prepared') {
    const pending = saved.writes.map(function(write) {
      const sheet = ss.getSheetByName(write.name);
      if (!sheet) throw new Error('RECORD_RECOVERY_SHEET_MISSING');
      if (write.row > sheet.getMaxRows()) return {write: write, restore: false};
      const actual = recordCellSnapshot_(sheet.getRange(write.row, 1, 1, write.width));
      const before = recordCellsEqual_(actual, write.before, write);
      if (!before && !recordCellsEqual_(actual, write.after, write)) throw new Error('RECORD_RECOVERY_CONFLICT');
      return {write: write, restore: !before};
    });
    pending.forEach(function(item) {
      if (item.restore) writeRecordCells_(ss.getSheetByName(item.write.name)
        .getRange(item.write.row, 1, 1, item.write.width), item.write.before);
    });
    SpreadsheetApp.flush();
    pending.forEach(function(item) {
      const sheet = ss.getSheetByName(item.write.name);
      if (item.write.row <= sheet.getMaxRows() && !recordCellsEqual_(
        recordCellSnapshot_(sheet.getRange(item.write.row, 1, 1, item.write.width)), item.write.before, item.write
      )) throw new Error('RECORD_ROLLBACK_READBACK_FAILED');
    });
  } else if (transaction.phase !== 'committed') throw new Error('RECORD_JOURNAL_PHASE_INVALID');
  properties.deleteProperty(recordTransactionKey_());
  try { ss.deleteSheet(journal); } catch (error) { console.error('Unused record journal retained.'); }
}
