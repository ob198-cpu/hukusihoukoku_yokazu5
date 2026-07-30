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
        // The temporary merged result keeps the current device value. The caller
        // must ask the user which value to keep before this result is saved.
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

    return { data: data, conflicts: conflicts };
  }

  function findRecordIndex(collection, records, key) {
    return (records || []).findIndex(function (record, index) {
      return recordKey(collection, record, index) === key;
    });
  }

  function upsertResolvedRecord(collection, records, key, value) {
    const index = findRecordIndex(collection, records, key);
    if (value == null) {
      if (index >= 0) records.splice(index, 1);
      return;
    }
    if (index >= 0) records[index] = clone(value);
    else records.push(clone(value));
  }

  function resolveConflicts(mergedSnapshot, conflicts, choice, options) {
    if (choice !== "local" && choice !== "remote") {
      throw new Error("競合の採用元を選択してください。");
    }
    const data = clone(mergedSnapshot || {});
    COLLECTIONS.forEach(function (collection) {
      if (!Array.isArray(data[collection])) data[collection] = [];
    });

    (conflicts || []).forEach(function (conflict) {
      const records = data[conflict.collection] || (data[conflict.collection] = []);
      const chosenValue = choice === "local" ? conflict.localValue : conflict.remoteValue;
      if (conflict.kind === "same-field-change") {
        const index = findRecordIndex(conflict.collection, records, conflict.recordKey);
        if (index < 0) return;
        if (chosenValue === undefined) delete records[index][conflict.field];
        else records[index][conflict.field] = clone(chosenValue);
        return;
      }
      upsertResolvedRecord(conflict.collection, records, conflict.recordKey, chosenValue);
    });

    if ((conflicts || []).length) {
      const now = options && options.now ? options.now : new Date().toISOString();
      const id = options && options.id
        ? options.id
        : "sync_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      data.history.unshift({
        id: id,
        at: now,
        action: "競合確認",
        type: "sync",
        recordId: "",
        label: "競合した入力を確認して" + (choice === "local" ? "この端末" : "スプレッドシート") + "を採用（" + conflicts.length + "項目）",
        before: { conflicts: clone(conflicts) },
        after: { choice: choice }
      });
      data.history = data.history.slice(0, 1000);
    }

    return data;
  }

  return {
    COLLECTIONS: COLLECTIONS.slice(),
    equal: equal,
    mergeSnapshots: mergeSnapshots,
    resolveConflicts: resolveConflicts
  };
});
