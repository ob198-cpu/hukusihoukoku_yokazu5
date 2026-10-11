/* Shared by the browser and Apps Script. No storage or network access. */
var SnsRecordSync = (function () {
  'use strict';
  const collections = ['accounts', 'posts', 'workMetrics', 'followers', 'inquiries',
    'lsteps', 'monitoring', 'agencyNotices', 'history'];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  function key(collection, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
    if (record.id) return 'id:' + String(record.id);
    if (collection === 'accounts') return 'account:' + JSON.stringify([
      record.business || '', record.sns || '', record.name || ''
    ]);
    return '';
  }
  function index(collection, records) {
    const result = new Map();
    (records || []).forEach((record, i) => {
      const id = key(collection, record) || 'legacy:' + i;
      if (result.has(id)) throw new Error('DUPLICATE_ID: ' + collection);
      result.set(id, record);
    });
    return result;
  }
  function diff(rawBase, viewBase, next) {
    if (!rawBase || !viewBase) throw new Error('BASE_REQUIRED: 保存元を確認できません。入力は残しています。');
    const changes = [];
    collections.forEach(collection => {
      const raw = index(collection, rawBase[collection]);
      const base = index(collection, viewBase[collection]);
      const local = index(collection, next[collection]);
      new Set([...base.keys(), ...local.keys()]).forEach(id => {
        const beforeView = base.get(id) || null;
        const after = local.get(id) || null;
        if (equal(beforeView, after)) return;
        // History omitted by the bounded UI is not an instruction to erase it.
        if (collection === 'history' && after === null) return;
        if (id.startsWith('legacy:')) throw new Error('IDENTITY_REQUIRED: ' + collection);
        changes.push({collection, key: id, before: clone(raw.get(id) || null), after: clone(after)});
      });
    });
    return changes;
  }
  function validate(changes) {
    if (!Array.isArray(changes)) throw new Error('INVALID_CHANGES');
    const seen = new Set();
    changes.forEach(change => {
      if (!change || !collections.includes(change.collection)) throw new Error('INVALID_COLLECTION');
      if (typeof change.key !== 'string' || !change.key) throw new Error('INVALID_IDENTITY');
      for (const side of ['before', 'after']) {
        if (change[side] !== null && key(change.collection, change[side]) !== change.key) {
          throw new Error('INVALID_IDENTITY');
        }
      }
      if (change.before === null && change.after === null) throw new Error('EMPTY_CHANGE');
      if (change.collection === 'history' && change.after === null) throw new Error('HISTORY_DELETE_NOT_ALLOWED');
      const unique = JSON.stringify([change.collection, change.key]);
      if (seen.has(unique)) throw new Error('DUPLICATE_CHANGE');
      seen.add(unique);
    });
  }
  function apply(current, changes) {
    validate(changes);
    const result = clone(current);
    const maps = Object.fromEntries(collections.map(collection => [collection, index(collection, current[collection])]));
    changes.forEach(change => {
      const found = maps[change.collection].get(change.key) || null;
      if (!equal(found, change.after) && !equal(found, change.before)) {
        throw new Error('CONFLICT: ' + change.collection + ' / ' + change.key);
      }
    });
    changes.forEach(change => {
      const rows = result[change.collection] || (result[change.collection] = []);
      const i = rows.findIndex(row => key(change.collection, row) === change.key);
      if (change.after === null) { if (i >= 0) rows.splice(i, 1); }
      else if (i >= 0) rows[i] = clone(change.after);
      else rows.push(clone(change.after));
    });
    return result;
  }
  function verify(snapshot, changes) {
    validate(changes);
    return changes.every(change => equal(
      index(change.collection, snapshot[change.collection]).get(change.key) || null, change.after
    ));
  }
  return {diff, apply, verify, key, equal, clone, validate};
})();
if (typeof module === 'object' && module.exports) module.exports = SnsRecordSync;
