const RECOVERY_ARCHIVE_TAB = '過去の復旧コピー';
const RECOVERY_ARCHIVE_HEADERS = ['保存ID', '保存日時', '事業所', '保存元', '分割番号', '分割数', '復旧データ(JSON)', '記録ID'];

function recoveryStorageKey_() {
  return 'sns_operation_report_' + ACTIVE_SYSTEM_KEY + '_v4:recovery_snapshots_v2';
}

function recoveryArchiveTarget_(request) {
  if (!recordSaveSupported_() || request.spreadsheetId !== ACTIVE_SPREADSHEET_ID
    || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(request.requestId)) {
    throw new Error('RECOVERY_ARCHIVE_TARGET_MISMATCH');
  }
}

function recoveryArchiveSheet_() {
  const ss = targetSpreadsheet_();
  let sheet = ss.getSheetByName(RECOVERY_ARCHIVE_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(RECOVERY_ARCHIVE_TAB);
    sheet.getRange(1, 1, 1, RECOVERY_ARCHIVE_HEADERS.length).setValues([RECOVERY_ARCHIVE_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 170);
    sheet.setColumnWidth(2, 190);
    sheet.setColumnWidth(3, 110);
    sheet.setColumnWidth(4, 350);
    sheet.setColumnWidths(5, 2, 85);
    sheet.setColumnWidth(7, 560);
    sheet.setColumnWidth(8, 200);
  }
  if (JSON.stringify(sheet.getRange(1, 1, 1, 8).getValues()[0]) !== JSON.stringify(RECOVERY_ARCHIVE_HEADERS)) {
    throw new Error('RECOVERY_ARCHIVE_HEADER_MISMATCH');
  }
  return sheet;
}

function recoveryDigest_(key, payload) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ACTIVE_SYSTEM_KEY + '\n' + key + '\n' + payload, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function recoveryReceipt_(request, sheet) {
  return {systemKey:ACTIVE_SYSTEM_KEY, spreadsheetId:ACTIVE_SPREADSHEET_ID, requestId:request.requestId,
    backendBuildId:BACKEND_BUILD_ID, tabName:RECOVERY_ARCHIVE_TAB, sheetId:sheet.getSheetId(), verified:true};
}

function findRecoveryCopy_(sheet, digest) {
  if (!/^[a-f0-9]{64}$/.test(String(digest))) throw new Error('INVALID_RECOVERY_DIGEST');
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    if (ids[i][0] !== digest) continue;
    const first = sheet.getRange(i + 2, 1, 1, 8).getValues()[0];
    const count = Number(first[5]);
    if (first[4] !== 1 || !Number.isInteger(count) || count < 1 || count > 300 || i + count > ids.length) continue;
    const rows = sheet.getRange(i + 2, 1, count, 8).getValues();
    if (rows.some(function(r, n) { return r[0] !== digest || r[2] !== ACTIVE_SYSTEM_KEY || r[3] !== recoveryStorageKey_()
      || r[4] !== n + 1 || r[5] !== count || r[7] !== first[7] || !String(r[6]).startsWith('j:'); })) continue;
    const payload = rows.map(function(r) { return String(r[6]).slice(2); }).join('');
    if (recoveryDigest_(first[3], payload) === digest) return {digest:digest, payload:payload, parts:count};
  }
  return null;
}

function archiveRecoveryCopy_(request) {
  recoveryArchiveTarget_(request);
  const key = request.storageKey, payload = request.payload;
  if (key !== recoveryStorageKey_() || typeof payload !== 'string' || payload.length > 8 * 1024 * 1024) throw new Error('INVALID_RECOVERY_COPY');
  const digest = recoveryDigest_(key, payload);
  if (digest !== request.digest) throw new Error('RECOVERY_DIGEST_MISMATCH');
  const sheet = recoveryArchiveSheet_();
  let found = findRecoveryCopy_(sheet, digest);
  if (!found) {
    const chunks = [];
    for (let offset = 0; offset < payload.length;) {
      let end = Math.min(offset + 30000, payload.length);
      const code = payload.charCodeAt(end - 1);
      if (end < payload.length && code >= 0xD800 && code <= 0xDBFF) end -= 1;
      chunks.push(payload.slice(offset, end)); offset = end;
    }
    if (!chunks.length) chunks.push('');
    const at = new Date().toISOString(), attempt = Utilities.getUuid();
    const rows = chunks.map(function(chunk, index) { return [digest, at, ACTIVE_SYSTEM_KEY, key, index + 1, chunks.length, 'j:' + chunk, attempt]; });
    const start = sheet.getLastRow() + 1;
    if (sheet.getMaxRows() < start + rows.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), start + rows.length - 1 - sheet.getMaxRows());
    sheet.getRange(start, 1, rows.length, 8).setValues(rows);
    SpreadsheetApp.flush();
    found = findRecoveryCopy_(sheet, digest);
  }
  if (!found || found.payload !== payload) throw new Error('RECOVERY_ARCHIVE_READBACK_FAILED');
  return Object.assign(recoveryReceipt_(request, sheet), {digest:digest, parts:found.parts});
}

function readRecoveryCopy_(request) {
  recoveryArchiveTarget_(request);
  const sheet = recoveryArchiveSheet_(), found = findRecoveryCopy_(sheet, request.digest);
  if (!found) throw new Error('RECOVERY_COPY_NOT_FOUND');
  return Object.assign(recoveryReceipt_(request, sheet), found);
}

function ensureRecoveryArchive_(request) {
  recoveryArchiveTarget_(request);
  return recoveryReceipt_(request, recoveryArchiveSheet_());
}

function migrateLegacyRecoveryCopies_(request) {
  recoveryArchiveTarget_(request);
  if (ACTIVE_SYSTEM_KEY !== 'yokazu7') throw new Error('LEGACY_RECOVERY_TARGET_MISMATCH');
  const legacy = targetSpreadsheet_().getSheetByName('BrowserArchives');
  const start = Math.max(2, Number(request.startRow) || 2), last = legacy ? legacy.getLastRow() : 1;
  let row = start, copied = 0;
  while (row <= last && copied < 3) {
    const first = legacy.getRange(row, 1, 1, 8).getValues()[0];
    const count = Number(first[6]);
    if (first[4] !== recoveryStorageKey_() || first[5] !== 1) { row += 1; continue; }
    if (!Number.isInteger(count) || count < 1 || count > 300 || row + count - 1 > last) throw new Error('LEGACY_RECOVERY_INCOMPLETE');
    const rows = legacy.getRange(row, 1, count, 8).getValues();
    if (rows.some(function(r, n) { return r[0] !== first[0] || r[2] !== ACTIVE_SYSTEM_KEY || r[4] !== first[4]
      || r[5] !== n + 1 || r[6] !== count || !String(r[7]).startsWith('j:'); })) throw new Error('LEGACY_RECOVERY_CORRUPT');
    const payload = rows.map(function(r) { return String(r[7]).slice(2); }).join('');
    const oldDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, first[4] + '\n' + payload, Utilities.Charset.UTF_8)
      .map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
    if (oldDigest !== first[0]) throw new Error('LEGACY_RECOVERY_DIGEST_MISMATCH');
    archiveRecoveryCopy_(Object.assign({}, request, {storageKey:first[4], payload:payload, digest:recoveryDigest_(first[4], payload)}));
    copied += 1; row += count;
  }
  return Object.assign(recoveryReceipt_(request, recoveryArchiveSheet_()), {copied:copied, nextRow:row, done:row > last});
}
