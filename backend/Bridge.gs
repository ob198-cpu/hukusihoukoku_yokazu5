function sheetBridgePage_(parameters) {
  const origin = String(parameters.parentOrigin || '');
  const token = String(parameters.channelToken || '');
  if (!recordSaveEnabled_(parameters.systemKey) || !/^[a-f0-9]{48}$/.test(token)
    || !(origin === 'https://ob198-cpu.github.io' || /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin))) {
    throw new Error('INVALID_BRIDGE_TARGET');
  }
  const config = JSON.stringify({origin:origin, token:token, systemKey:parameters.systemKey}).replace(/</g, '\\u003c');
  const html = HtmlService.createHtmlOutputFromFile('BridgePage').getContent().replace('"__BRIDGE_CONFIG__"', config);
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function snsBridgeRequest(payload, systemKey) {
  if (typeof payload !== 'string' || payload.length > 8 * 1024 * 1024) throw new Error('INVALID_BRIDGE_REQUEST');
  const request = JSON.parse(payload);
  // The existing Hatchobori bridge can omit this second argument until its iframe reloads.
  if (!recordSaveEnabled_(request.systemKey) || request.systemKey !== (systemKey || 'yokazu5')
    || ['loadData', 'saveChanges', 'archiveRecoveryCopy', 'readRecoveryCopy', 'ensureRecoveryArchive', 'migrateLegacyRecoveryCopies'].indexOf(request.action) < 0) {
    throw new Error('INVALID_BRIDGE_TARGET');
  }
  // Use the same lock, target checks, conflict handling and readback as the POST API.
  return doPost({postData:{contents:payload}}).getContent();
}
