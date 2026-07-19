const SPREADSHEET_ID = '1J2Jfv4PIj2C3RMoX2ZH5jW946FFBN6p25FJkk8TsvGU';
const SPREADSHEET_IDS = Object.freeze({
  hukusihoukoku: '1TMZQ44meDSEzgYROwGbt2fAI6bCvZVcfjCLqoBOo1Dk',
  yokazu: '1RzDcasCT_eAyE0xSs9j9O2y06dLoT8rCcBCIE42qvSc',
  yokazu2: '17H7ADWm1j3JrnsPS8OkWZocuOWa-LgFRd5i5BSP88QE',
  yokazu3: '1B3NK5mt7JyNxhW8RxZEFZVyKBQjBoLZ_K9_4cS2LvII',
  yokazu4: '1PQHhwKMYXPUcW6EfreYR1YWYf2Zt2Hx4uPi2sV-ueWQ',
  yokazu5: SPREADSHEET_ID,
  yokazu6: '1jSqqwpje5yokIrBlrwtNW5XrcbC__Q8KhSlHFZsXiJg'
});
let ACTIVE_SPREADSHEET_ID = SPREADSHEET_ID;
let ACTIVE_SYSTEM_KEY = 'yokazu5';
const SAVE_TRANSACTION_KEY_PREFIX = 'SNS_SAVE_TRANSACTION_';
const SHEETS = {
  state: { name: 'State', headers: ['key', 'json', 'updatedAt'] },
  posts: { name: 'Posts', headers: ['id', 'weekStart', 'weekEnd', 'date', 'postTime', 'business', 'account', 'sns', 'postType', 'content', 'impressions', 'likes', 'comments', 'shares', 'saves', 'profileAccesses', 'linkClicks', 'followers', 'operator', 'inputAt', 'updatedAt', 'note', 'json'] },
  workMetrics: { name: 'WorkMetrics', headers: ['id', 'date', 'sns', 'workName', 'content', 'impressions', 'likes', 'comments', 'shares', 'saves', 'profileAccesses', 'linkClicks', 'operator', 'inputAt', 'updatedAt', 'json'] },
  followers: { name: 'Followers', headers: ['id', 'date', 'business', 'sns', 'followers', 'operator', 'inputAt', 'updatedAt', 'json'] },
  inquiries: { name: 'Inquiries', headers: ['id', 'weekStart', 'weekEnd', 'date', 'business', 'sns', 'type', 'content', 'status', 'operator', 'inputAt', 'updatedAt', 'json'] },
  lsteps: { name: 'LSteps', headers: ['id', 'weekStart', 'weekEnd', 'checkDate', 'business', 'previous', 'current', 'limit', 'operator', 'inputAt', 'updatedAt', 'used', 'remaining', 'json'] },
  monitoring: { name: 'Monitoring', headers: ['id', 'userName', 'month', 'visited', 'recordDone', 'meetingRequired', 'meetingDone', 'reportDone', 'mailed', 'returned', 'officeSent', 'billingDone', 'billingSent', 'addOn', 'continueType', 'note', 'operator', 'inputAt', 'updatedAt', 'json'] },
  agencyNotices: { name: 'AgencyNotices', headers: ['id', 'userName', 'month', 'created', 'sent', 'note', 'json'] },
  history: { name: 'History', headers: ['id', 'at', 'action', 'type', 'recordId', 'label', 'beforeJson', 'afterJson'] },
  syncHistory: { name: 'SyncHistory', headers: ['at', 'result', 'expectedRevision', 'serverRevisionBefore', 'serverRevisionAfter', 'posts', 'workMetrics', 'followers', 'inquiries', 'lsteps', 'clientId'] }
};

function doGet(e) {
  const systemKey = selectSpreadsheet_(e && e.parameter && e.parameter.systemKey);
  recoverPendingSave_();
  ensureAllSheets_();
  return json_({ ok: true, data: { status: 'ready', systemKey: systemKey, updatedAt: readUpdatedAt_() } });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(30000);
    locked = true;
    const request = JSON.parse((e.postData && e.postData.contents) || '{}');
    selectSpreadsheet_(request.systemKey);
    recoverPendingSave_();
    ensureAllSheets_();
    const action = request.action || '';
    if (action === 'loadData') return json_({ ok: true, data: { data: readData_(), updatedAt: readUpdatedAt_() } });
    if (action === 'saveData') {
      return json_({ ok: true, data: saveData_(request.data || {}, request.expectedUpdatedAt || '', request.clientId || '') });
    }
    throw new Error('未対応の操作です: ' + action);
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function saveData_(data, expectedUpdatedAt, clientId) {
  const currentUpdatedAt = readUpdatedAt_();
  if (currentUpdatedAt && !expectedUpdatedAt) {
    appendSyncHistory_('conflict', expectedUpdatedAt, currentUpdatedAt, '', data, clientId);
    throw new Error('CONFLICT: 保存元の版情報がありません。再読み込みして内容を確認してください。');
  }
  if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
    appendSyncHistory_('conflict', expectedUpdatedAt, currentUpdatedAt, '', data, clientId);
    throw new Error('CONFLICT: 他の端末で先に更新されています。再読み込みして内容を確認してください。');
  }

  const normalized = normalizeData_(data);
  const updatedAt = new Date().toISOString() + '#' + Utilities.getUuid().slice(0, 8);
  commitDataSafely_(normalized, updatedAt);

  try {
    appendSyncHistory_('saved', expectedUpdatedAt, currentUpdatedAt, updatedAt, normalized, clientId);
  } catch (historyError) {
    console.error('SyncHistory write failed: ' + historyError.message);
  }
  return { data: readData_(), updatedAt: updatedAt };
}

function commitDataSafely_(data, updatedAt) {
  const ss = targetSpreadsheet_();
  const generation = Date.now() + '_' + Utilities.getUuid().slice(0, 8);
  const payloads = buildSavePayloads_(data, updatedAt);
  const transaction = {
    systemKey: ACTIVE_SYSTEM_KEY,
    generation: generation,
    phase: 'preparing',
    sheets: payloads.map(function(payload) {
      return {
        name: payload.def.name,
        stagingName: payload.def.name + '__staging_' + generation,
        oldName: payload.def.name + '__old_' + generation
      };
    })
  };
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(saveTransactionKey_(), JSON.stringify(transaction));

  try {
    payloads.forEach(function(payload, index) {
      const info = transaction.sheets[index];
      const staging = ss.insertSheet(info.stagingName);
      writeRowsToEmptySheet_(staging, payload.def, payload.rows);
    });
    transaction.phase = 'prepared';
    properties.setProperty(saveTransactionKey_(), JSON.stringify(transaction));

    payloads.forEach(function(payload, index) {
      const info = transaction.sheets[index];
      const active = ss.getSheetByName(info.name);
      const staging = ss.getSheetByName(info.stagingName);
      if (!active || !staging) throw new Error('保存世代の準備に失敗しました: ' + info.name);
      active.setName(info.oldName);
      staging.setName(info.name);
    });

    transaction.phase = 'committed';
    properties.setProperty(saveTransactionKey_(), JSON.stringify(transaction));
    cleanupCommittedSave_(transaction);
    properties.deleteProperty(saveTransactionKey_());
  } catch (error) {
    try { recoverPendingSave_(); } catch (recoveryError) {
      console.error('Save recovery failed: ' + recoveryError.message);
    }
    throw error;
  }
}

function buildSavePayloads_(data, updatedAt) {
  const stateMeta = { accounts: data.accounts || [], savedAt: updatedAt };
  return [
    { def: SHEETS.state, rows: [['data', JSON.stringify(stateMeta), updatedAt]] },
    { def: SHEETS.posts, rows: array_(data.posts).map(postRow_) },
    { def: SHEETS.workMetrics, rows: array_(data.workMetrics).map(workMetricRow_) },
    { def: SHEETS.followers, rows: array_(data.followers).map(followerRow_) },
    { def: SHEETS.inquiries, rows: array_(data.inquiries).map(inquiryRow_) },
    { def: SHEETS.lsteps, rows: array_(data.lsteps).map(lstepRow_) },
    { def: SHEETS.monitoring, rows: array_(data.monitoring).map(monitoringRow_) },
    { def: SHEETS.agencyNotices, rows: array_(data.agencyNotices).map(agencyNoticeRow_) },
    { def: SHEETS.history, rows: historyRows_(data.history) }
  ];
}

function writeRowsToEmptySheet_(sheet, def, rows) {
  if (sheet.getLastRow() > 0) throw new Error('安全保存先が空ではありません: ' + sheet.getName());
  if (sheet.getMaxColumns() < def.headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), def.headers.length - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < rows.length + 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  }
  sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows);
  sheet.setFrozenRows(1);
}

function recoverPendingSave_() {
  const properties = PropertiesService.getScriptProperties();
  const raw = properties.getProperty(saveTransactionKey_());
  if (!raw) return;
  const transaction = JSON.parse(raw);
  if (!transaction || transaction.systemKey !== ACTIVE_SYSTEM_KEY || !Array.isArray(transaction.sheets)) {
    throw new Error('保存復旧情報が不正です。管理者に連絡してください。');
  }
  if (transaction.phase === 'committed') {
    cleanupCommittedSave_(transaction);
    properties.deleteProperty(saveTransactionKey_());
    return;
  }

  const ss = targetSpreadsheet_();
  transaction.sheets.slice().reverse().forEach(function(info) {
    const oldSheet = ss.getSheetByName(info.oldName);
    const activeSheet = ss.getSheetByName(info.name);
    const stagingSheet = ss.getSheetByName(info.stagingName);
    if (oldSheet) {
      if (activeSheet && activeSheet.getSheetId() !== oldSheet.getSheetId()) ss.deleteSheet(activeSheet);
      oldSheet.setName(info.name);
    }
    const remainingStage = ss.getSheetByName(info.stagingName);
    if (remainingStage) ss.deleteSheet(remainingStage);
    if (!oldSheet && stagingSheet && stagingSheet.getSheetId() !== (activeSheet && activeSheet.getSheetId())) {
      const orphan = ss.getSheetByName(info.stagingName);
      if (orphan) ss.deleteSheet(orphan);
    }
  });
  properties.deleteProperty(saveTransactionKey_());
}

function cleanupCommittedSave_(transaction) {
  const ss = targetSpreadsheet_();
  transaction.sheets.forEach(function(info) {
    const oldSheet = ss.getSheetByName(info.oldName);
    if (oldSheet) ss.deleteSheet(oldSheet);
    const stagingSheet = ss.getSheetByName(info.stagingName);
    if (stagingSheet) ss.deleteSheet(stagingSheet);
  });
}

function saveTransactionKey_() {
  return SAVE_TRANSACTION_KEY_PREFIX + ACTIVE_SYSTEM_KEY;
}

function appendSyncHistory_(result, expectedRevision, beforeRevision, afterRevision, data, clientId) {
  const sheet = targetSpreadsheet_().getSheetByName(SHEETS.syncHistory.name);
  const counts = data || {};
  sheet.appendRow([
    new Date().toISOString(),
    result || '',
    expectedRevision || '',
    beforeRevision || '',
    afterRevision || '',
    array_(counts.posts).length,
    array_(counts.workMetrics).length,
    array_(counts.followers).length,
    array_(counts.inquiries).length,
    array_(counts.lsteps).length,
    clientId || ''
  ]);
  if (sheet.getLastRow() > 5001) sheet.deleteRows(2, sheet.getLastRow() - 5001);
}

function readData_() {
  const state = readState_();
  return {
    accounts: state.accounts || [],
    posts: readJsonColumn_(SHEETS.posts),
    workMetrics: readJsonColumn_(SHEETS.workMetrics),
    followers: readJsonColumn_(SHEETS.followers),
    inquiries: readJsonColumn_(SHEETS.inquiries),
    lsteps: readJsonColumn_(SHEETS.lsteps),
    monitoring: readJsonColumn_(SHEETS.monitoring),
    agencyNotices: readJsonColumn_(SHEETS.agencyNotices),
    history: readHistory_()
  };
}

function ensureAllSheets_() {
  Object.keys(SHEETS).forEach(function(key) {
    ensureSheet_(SHEETS[key]);
  });
}

function ensureSheet_(def) {
  const ss = targetSpreadsheet_();
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) sheet = ss.insertSheet(def.name);
  if (sheet.getLastRow() === 0) sheet.appendRow(def.headers);
}

function writeState_(data) {
  const meta = {
    accounts: data.accounts || [],
    savedAt: new Date().toISOString()
  };
  writeRawRows_(SHEETS.state, [['data', JSON.stringify(meta), meta.savedAt]]);
}

function readState_() {
  const rows = readRawRows_(SHEETS.state);
  const row = rows.find(function(item) { return item[0] === 'data'; });
  if (!row) return {};
  try {
    return JSON.parse(row[1] || '{}');
  } catch (e) {
    return {};
  }
}

function readUpdatedAt_() {
  const rows = readRawRows_(SHEETS.state);
  const row = rows.find(function(item) { return item[0] === 'data'; });
  return row ? String(row[2] || '') : '';
}

function writeRows_(def, rows, mapper) {
  writeRawRows_(def, (rows || []).map(mapper));
}

function writeRawRows_(def, rows) {
  replaceSingleSheetSafely_(def, rows || []);
}

function replaceSingleSheetSafely_(def, rows) {
  const ss = targetSpreadsheet_();
  const active = ss.getSheetByName(def.name);
  const token = Date.now() + '_' + Utilities.getUuid().slice(0, 8);
  const staging = ss.insertSheet(def.name + '__staging_' + token);
  const oldName = def.name + '__old_' + token;
  writeRowsToEmptySheet_(staging, def, rows);
  try {
    if (active) active.setName(oldName);
    staging.setName(def.name);
    if (active) ss.deleteSheet(active);
  } catch (error) {
    const current = ss.getSheetByName(def.name);
    if (active) {
      if (current && current.getSheetId() !== active.getSheetId()) ss.deleteSheet(current);
      active.setName(def.name);
    }
    const remaining = ss.getSheetByName(def.name + '__staging_' + token);
    if (remaining) ss.deleteSheet(remaining);
    throw error;
  }
}

function readRawRows_(def) {
  const sheet = targetSpreadsheet_().getSheetByName(def.name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, def.headers.length).getValues();
}

function readJsonColumn_(def) {
  const jsonIndex = def.headers.indexOf('json');
  if (jsonIndex < 0) return [];
  return readRawRows_(def).map(function(row) {
    try {
      var raw = row[jsonIndex];
      if (!raw) {
        for (var i = row.length - 1; i >= 0; i--) {
          if (typeof row[i] === 'string' && /^[\[{]/.test(row[i].trim())) {
            raw = row[i];
            break;
          }
        }
      }
      return JSON.parse(raw || '{}');
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function writeHistory_(history) {
  writeRawRows_(SHEETS.history, historyRows_(history));
}

function historyRows_(history) {
  return (history || []).slice(0, 1000).map(function(item) {
    return [
      item.id || '',
      item.at || '',
      item.action || '',
      item.type || '',
      item.recordId || '',
      item.label || '',
      JSON.stringify(item.before || null),
      JSON.stringify(item.after || null)
    ];
  });
}

function readHistory_() {
  return readRawRows_(SHEETS.history).map(function(row) {
    return {
      id: row[0] || '',
      at: row[1] || '',
      action: row[2] || '',
      type: row[3] || '',
      recordId: row[4] || '',
      label: row[5] || '',
      before: parseJson_(row[6]),
      after: parseJson_(row[7])
    };
  }).filter(function(item) { return item.id || item.at || item.action; });
}

function normalizeData_(data) {
  data = data || {};
  return {
    accounts: array_(data.accounts),
    posts: array_(data.posts),
    workMetrics: array_(data.workMetrics),
    followers: array_(data.followers),
    inquiries: array_(data.inquiries),
    lsteps: array_(data.lsteps),
    monitoring: array_(data.monitoring),
    agencyNotices: array_(data.agencyNotices),
    history: array_(data.history).slice(0, 1000)
  };
}

function postRow_(item) {
  return [item.id || '', item.weekStart || '', item.weekEnd || '', item.date || '', item.postTime || '', item.business || '', item.account || '', item.sns || '', item.postType || '', item.content || '', number_(item.impressions), number_(item.likes), number_(item.comments), number_(item.shares), number_(item.saves), number_(item.profileAccesses), number_(item.linkClicks), number_(item.followers), item.operator || '', item.inputAt || '', item.updatedAt || '', item.note || '', JSON.stringify(item)];
}

function workMetricRow_(item) {
  return [item.id || '', item.date || '', item.sns || '', item.workName || '', item.content || '', number_(item.impressions), number_(item.likes), number_(item.comments), number_(item.shares), number_(item.saves), number_(item.profileAccesses), number_(item.linkClicks), item.operator || '', item.inputAt || '', item.updatedAt || '', JSON.stringify(item)];
}

function followerRow_(item) {
  return [item.id || '', item.date || '', item.business || '', item.sns || '', number_(item.followers), item.operator || '', item.inputAt || '', item.updatedAt || '', JSON.stringify(item)];
}

function inquiryRow_(item) {
  return [item.id || '', item.weekStart || '', item.weekEnd || '', item.date || '', item.business || '', item.sns || '', item.type || '', item.content || '', item.status || '', item.operator || '', item.inputAt || '', item.updatedAt || '', JSON.stringify(item)];
}

function lstepRow_(item) {
  const used = number_(item.previous) + number_(item.current);
  const limit = number_(item.limit || 200);
  return [item.id || '', item.weekStart || '', item.weekEnd || '', item.checkDate || '', item.business || '', number_(item.previous), number_(item.current), limit, item.operator || '', item.inputAt || '', item.updatedAt || '', used, Math.max(0, limit - used), JSON.stringify(item)];
}

function monitoringRow_(item) {
  return [item.id || '', item.userName || '', item.month || '', bool_(item.visited), bool_(item.recordDone), bool_(item.meetingRequired), bool_(item.meetingDone), bool_(item.reportDone), bool_(item.mailed), bool_(item.returned), bool_(item.officeSent), bool_(item.billingDone), bool_(item.billingSent), bool_(item.addOn), item.continueType || '', item.note || '', item.operator || '', item.inputAt || '', item.updatedAt || '', JSON.stringify(item)];
}

function agencyNoticeRow_(item) {
  return [item.id || '', item.userName || '', item.month || '', bool_(item.created), bool_(item.sent), item.note || '', JSON.stringify(item)];
}

function targetSpreadsheet_() {
  return SpreadsheetApp.openById(ACTIVE_SPREADSHEET_ID);
}

function selectSpreadsheet_(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) throw new Error('保存先IDが指定されていません。');
  const spreadsheetId = SPREADSHEET_IDS[key];
  if (!spreadsheetId) throw new Error('保存先IDが不正です。');
  ACTIVE_SYSTEM_KEY = key;
  ACTIVE_SPREADSHEET_ID = spreadsheetId;
  return key;
}

function array_(value) {
  return Array.isArray(value) ? value : [];
}

function number_(value) {
  return Math.max(0, Number(value || 0));
}

function bool_(value) {
  return value === true;
}

function parseJson_(value) {
  try {
    return JSON.parse(value || 'null');
  } catch (e) {
    return null;
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
