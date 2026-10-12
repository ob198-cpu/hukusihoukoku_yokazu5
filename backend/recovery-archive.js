(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SnsRecoveryArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function create({storage, recoveryKey, systemKey, spreadsheetId, request, digest, ready, onStatus = () => {}}) {
    let busy = false;
    const volatile = new Map();
    function report(text) { try { onStatus(text); } catch { /* A status failure must not block sending. */ } }
    function enqueue(entry) {
      const identity = JSON.stringify(entry.data);
      if (!volatile.has(identity)) volatile.set(identity, JSON.stringify([entry]));
    }
    function check(result, id, hash) {
      if (!result?.verified || result.systemKey !== systemKey || result.spreadsheetId !== spreadsheetId
        || result.requestId !== id || result.digest !== hash || result.tabName !== '過去の復旧コピー') throw Error('RECOVERY_RECEIPT_MISMATCH');
    }
    async function run() {
      if (busy || !ready()) return;
      busy = true;
      try {
        let local = null;
        try { local = storage.getItem(recoveryKey); } catch { /* Volatile copies can still be archived. */ }
        const snapshots = [...new Set([...(local === null ? [] : [local]), ...volatile.values()])];
        for (const raw of snapshots) {
          if (!ready()) break;
          const hash = await digest(systemKey + '\n' + recoveryKey + '\n' + raw);
          const id = 'recovery_' + hash;
          const args = {spreadsheetId, requestId:id, storageKey:recoveryKey, payload:raw, digest:hash};
          check(await request('archiveRecoveryCopy', args), id, hash);
          const saved = await request('readRecoveryCopy', {spreadsheetId, requestId:id, digest:hash});
          check(saved, id, hash);
          if (saved.payload !== raw) throw Error('RECOVERY_CONTENT_MISMATCH');
          for (const [identity, value] of volatile) if (value === raw) volatile.delete(identity);
          try { if (storage.getItem(recoveryKey) === raw) storage.removeItem(recoveryKey); } catch { /* Server copy is verified; keep the local duplicate if removal fails. */ }
        }
        report('');
      } catch { report('復旧コピーはシート未保存です。画面を閉じず、接続回復をお待ちください。'); }
      finally { busy = false; }
    }
    return {run, enqueue, hasVolatile: () => volatile.size > 0};
  }
  return {create};
});
