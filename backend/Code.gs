const SPREADSHEET_ID = '1J2Jfv4PIj2C3RMoX2ZH5jW946FFBN6p25FJkk8TsvGU';
const SPREADSHEET_IDS = Object.freeze({
  yokazu2: '17H7ADWm1j3JrnsPS8OkWZocuOWa-LgFRd5i5BSP88QE',
  yokazu3: '1B3NK5mt7JyNxhW8RxZEFZVyKBQjBoLZ_K9_4cS2LvII',
  yokazu4: '1PQHhwKMYXPUcW6EfreYR1YWYf2Zt2Hx4uPi2sV-ueWQ',
  yokazu5: SPREADSHEET_ID,
  yokazu6: '1jSqqwpje5yokIrBlrwtNW5XrcbC__Q8KhSlHFZsXiJg'
});
let ACTIVE_SPREADSHEET_ID = SPREADSHEET_ID;
let ACTIVE_SYSTEM_KEY = 'yokazu5';
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
  if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
    appendSyncHistory_('conflict', expectedUpdatedAt, currentUpdatedAt, '', data, clientId);
    throw new Error('CONFLICT: 他の端末で先に更新されています。再読み込みして内容を確認してください。');
  }

  const normalized = normalizeData_(data);
  writeRows_(SHEETS.posts, normalized.posts, postRow_);
  writeRows_(SHEETS.workMetrics, normalized.workMetrics, workMetricRow_);
  writeRows_(SHEETS.followers, normalized.followers, followerRow_);
  writeRows_(SHEETS.inquiries, normalized.inquiries, inquiryRow_);
  writeRows_(SHEETS.lsteps, normalized.lsteps, lstepRow_);
  writeRows_(SHEETS.monitoring, normalized.monitoring, monitoringRow_);
  writeRows_(SHEETS.agencyNotices, normalized.agencyNotices, agencyNoticeRow_);
  writeHistory_(normalized.history);
  writeState_(normalized);

  const updatedAt = readUpdatedAt_();
  appendSyncHistory_('saved', expectedUpdatedAt, currentUpdatedAt, updatedAt, normalized, clientId);
  return { data: readData_(), updatedAt: updatedAt };
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
  const sheet = targetSpreadsheet_().getSheetByName(def.name);
  sheet.clearContents();
  sheet.appendRow(def.headers);
  if (rows.length) sheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows);
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
  writeRawRows_(SHEETS.history, (history || []).slice(0, 1000).map(function(item) {
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
  }));
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
  const key = String(rawKey || 'yokazu5').trim();
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
