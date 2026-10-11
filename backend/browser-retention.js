/* Browser-only retention. Never sends data or changes a spreadsheet. */
var SnsBrowserRetention = (function () {
  'use strict';
  function create(options) {
    const {storage, primaryKey, baseKey, recoveryKey, pendingPrefix, dirtyKey, equal, normalize} = options;
    const cacheBytes = options.cacheBytes ?? 512 * 1024;
    const recoveryBytes = options.recoveryBytes ?? 512 * 1024;
    const recoveryCount = options.recoveryCount ?? 3;
    const failures = new Set(), proofs = new Map();
    let confirmed = null;
    const bytes = (key, raw) => raw == null ? 0 : (key.length + raw.length) * 2;
    const own = key => key === primaryKey || key.startsWith(primaryKey + ':');
    function read(key) { try { return storage.getItem(key); } catch { return null; } }
    function parse(raw) { try { return raw == null ? null : JSON.parse(raw); } catch { return null; } }
    function same(a, b) {
      if (!a || !b) return false;
      if (equal(a, b)) return true;
      // Do not normalize away unknown top-level data when deciding to delete a copy.
      const fields = ['accounts','posts','workMetrics','followers','inquiries','lsteps','monitoring','agencyNotices','history'];
      if ([...Object.keys(a), ...Object.keys(b)].some(key => !fields.includes(key))) return false;
      try { return equal(normalize(a), normalize(b)); } catch { return false; }
    }
    function pendingEntries() {
      const entries = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key === pendingPrefix || key?.startsWith(pendingPrefix + ':')) {
            entries.push({key, value: parse(read(key))});
          }
        }
      } catch { return null; }
      return entries;
    }
    function needed(key) {
      if (key === primaryKey) return read(dirtyKey) !== null;
      if (key !== baseKey) return false;
      const entries = pendingEntries();
      return !entries || entries.some(({value}) => !value || (!value.baseData && value.format !== 'record-changes-v1'));
    }
    function eligible(key, raw) {
      if (raw === null || needed(key)) return false;
      if (proofs.get(key) === raw) return true;
      const value = parse(raw);
      const snapshot = key === baseKey ? value?.data : value;
      if (!same(snapshot, confirmed)) return false;
      proofs.set(key, raw);
      return true;
    }
    function removeExact(key, raw) {
      try {
        if (storage.getItem(key) !== raw) return false;
        storage.removeItem(key);
        proofs.delete(key);
        failures.delete(key);
        return true;
      } catch { return false; }
    }
    function pruneRecovery() {
      const raw = read(recoveryKey), entries = parse(raw);
      if (!Array.isArray(entries)) return;
      const kept = entries.filter(entry => !same(entry?.data, confirmed));
      if (kept.length === entries.length) return;
      try {
        if (storage.getItem(recoveryKey) !== raw) return;
        if (kept.length) storage.setItem(recoveryKey, JSON.stringify(kept));
        else storage.removeItem(recoveryKey);
      } catch { /* Leave the original copy if housekeeping fails. */ }
    }
    function trim(pressure = false) {
      pruneRecovery();
      let total = [primaryKey, baseKey].reduce((sum, key) => sum + bytes(key, read(key)), 0);
      for (const key of [baseKey, primaryKey]) {
        const raw = read(key);
        if ((pressure || total > cacheBytes) && eligible(key, raw) && removeExact(key, raw)) total -= bytes(key, raw);
      }
    }
    function confirm(snapshot) {
      confirmed = JSON.parse(JSON.stringify(snapshot));
      for (const key of [primaryKey, baseKey]) eligible(key, read(key));
      trim();
    }
    function writeProtected(key, value) {
      if (!own(key)) return false;
      let raw;
      try { raw = JSON.stringify(value); } catch { failures.add(key); return false; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try { storage.setItem(key, raw); failures.delete(key); return true; }
        catch { if (attempt === 0) trim(true); }
      }
      failures.add(key);
      return false;
    }
    function cache(key, value) {
      if (![primaryKey, baseKey].includes(key) || !same(key === baseKey ? value?.data : value, confirmed)) return false;
      const raw = JSON.stringify(value), old = read(key);
      if (needed(key) || (old !== null && !eligible(key, old))) return false;
      trim();
      const other = key === primaryKey ? baseKey : primaryKey;
      if (bytes(key, raw) + bytes(other, read(other)) > cacheBytes) {
        if (eligible(key, old)) removeExact(key, old);
        return false;
      }
      try {
        if (read(key) !== old) return false;
        storage.setItem(key, raw); proofs.set(key, raw); return true;
      } catch { /* A confirmed sheet copy need not be cached. */ }
      return false;
    }
    function recover(entry) {
      if (!entry?.data) return false;
      if (same(entry.data, confirmed)) return true;
      if (pendingEntries()?.some(({value}) => value?.id && same(value.data, entry.data))) return true;
      pruneRecovery();
      const raw = read(recoveryKey), entries = raw === null ? [] : parse(raw);
      if (!Array.isArray(entries)) return false;
      if (entries.some(previous => same(previous?.data, entry.data))) return true;
      const next = [entry, ...entries], serialized = JSON.stringify(next);
      if (next.length > recoveryCount || bytes(recoveryKey, serialized) > recoveryBytes) return false;
      try {
        if (storage.getItem(recoveryKey) !== raw) return false;
        storage.setItem(recoveryKey, serialized); return true;
      } catch { return false; }
    }
    return {confirm, cache, recover, trim, writeProtected,
      hasFailures: () => failures.size > 0, forgetFailure: key => failures.delete(key)};
  }
  return {create};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnsBrowserRetention;
