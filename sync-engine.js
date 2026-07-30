(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SnsSyncMerge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLLECTIONS = [
    "accounts",
    "posts",
    "workMetrics",
    "followers",
    "inquiries",
    "lsteps",
    "monitoring",
    "agencyNotices",
    "history"
  ];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce(function (result, key) {
        result[key] = comparable(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function equal(left, right) {
    return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
  }

  function recordKey(collection, record, index) {
    if (record && record.id) return "id:" + record.id;
    if (collection === "accounts") {
      return "account:" + [
        record && record.business,
        record && record.sns,
        record && record.name
      ].join("|");
    }
    return "legacy:" + index + ":" + JSON.stringify(comparable(record));
  }

  function toMap(collection, records) {
    const map = new Map();
    (records || []).forEach(function (record, index) {
      map.set(recordKey(collection, record, index), clone(record));
    });
    return map;
  }

  function describeConflict(collection, key, field, localValue, remoteValue, kind) {
    return {
      collection: collection,
      recordKey: key,
      field: field || "",
      kind: kind,
      localValue: clone(localValue),
      remoteValue: clone(remoteValue)
    };
  }

  function mergeRecord(collection, key, baseRecord, localRecord, remoteRecord, conflicts) {
    const result = {};
    const fields = new Set([
      ...Object.keys(baseRecord || {}),
      ...Object.keys(localRecord || {}),
      ...Object.keys(remoteRecord || {})
    ]);

    fields.forEach(function (field) {
      const baseValue = baseRecord ? baseRecord[field] : undefined;
      const localValue = localRecord ? localRecord[field] : undefined;
      const remoteValue = remoteRecord ? remoteRecord[field] : undefined;

      if (equal(localValue, remoteValue)) {
        result[field] = clone(localValue);
      } else if (equal(localValue, baseValue)) {
        result[field] = clone(remoteValue);
      } else if (equal(remoteValue, baseValue)) {
        result[field] = clone(localValue);
      } else {
        // Both sides changed the same field. Keep the current user's edit in the
        // main record and retain both values in the audit history.
        result[field] = clone(localValue);
        conflicts.push(describeConflict(
          collection,
          key,
          field,
          localValue,
          remoteValue,
          "same-field-change"
        ));
      }
    });

    return result;
  }

  function mergeCollection(collection, baseRecords, localRecords, remoteRecords, conflicts) {
    const baseMap = toMap(collection, baseRecords);
    const localMap = toMap(collection, localRecords);
    const remoteMap = toMap(collection, remoteRecords);
    const keys = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    const merged = [];

    keys.forEach(function (key) {
      const baseRecord = baseMap.get(key);
      const localRecord = localMap.get(key);
      const remoteRecord = remoteMap.get(key);

      if (!baseRecord) {
        if (localRecord && remoteRecord) {
          merged.push(equal(localRecord, remoteRecord)
            ? clone(localRecord)
            : mergeRecord(collection, key, {}, localRecord, remoteRecord, conflicts));
        } else if (localRecord) {
          merged.push(clone(localRecord));
        } else if (remoteRecord) {
          merged.push(clone(remoteRecord));
        }
        return;
      }

      if (!localRecord && !remoteRecord) return;

      if (!localRecord) {
        if (equal(remoteRecord, baseRecord)) return;
        merged.push(clone(remoteRecord));
        conflicts.push(describeConflict(
          collection,
          key,
          "",
          null,
          remoteRecord,
          "delete-versus-remote-change"
        ));
        return;
      }

      if (!remoteRecord) {
        if (equal(localRecord, baseRecord)) return;
        merged.push(clone(localRecord));
        conflicts.push(describeConflict(
          collection,
          key,
          "",
          localRecord,
          null,
          "local-change-versus-delete"
        ));
        return;
      }

      if (equal(localRecord, baseRecord)) {
        merged.push(clone(remoteRecord));
      } else if (equal(remoteRecord, baseRecord)) {
        merged.push(clone(localRecord));
      } else if (equal(localRecord, remoteRecord)) {
        merged.push(clone(localRecord));
      } else {
        merged.push(mergeRecord(
          collection,
          key,
          baseRecord,
          localRecord,
          remoteRecord,
          conflicts
        ));
      }
    });

    return merged;
  }

  function mergeSnapshots(baseSnapshot, localSnapshot, remoteSnapshot, options) {
    const base = baseSnapshot || {};
    const local = localSnapshot || {};
    const remote = remoteSnapshot || {};
    const conflicts = [];
    const data = {};

    COLLECTIONS.forEach(function (collection) {
      data[collection] = mergeCollection(
        collection,
        base[collection] || [],
        local[collection] || [],
        remote[collection] || [],
        conflicts
      );
    });

    if (conflicts.length) {
      const now = options && options.now ? options.now : new Date().toISOString();
      const id = options && options.id
        ? options.id
        : "sync_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      data.history.unshift({
        id: id,
        at: now,
        action: "自動競合統合",
        type: "sync",
        recordId: "",
        label: "競合した入力を自動統合（" + conflicts.length + "項目）",
        before: { remoteConflicts: clone(conflicts) },
        after: { localConflicts: clone(conflicts) }
      });
      data.history = data.history.slice(0, 1000);
    }

    return { data: data, conflicts: conflicts };
  }

  return {
    COLLECTIONS: COLLECTIONS.slice(),
    equal: equal,
    mergeSnapshots: mergeSnapshots
  };
});
