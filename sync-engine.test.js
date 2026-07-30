"use strict";

const assert = require("assert");
const { mergeSnapshots } = require("./sync-engine.js");

function snapshot(posts = []) {
  return {
    accounts: [],
    posts,
    workMetrics: [],
    followers: [],
    inquiries: [],
    lsteps: [],
    monitoring: [],
    agencyNotices: [],
    history: []
  };
}

const base = snapshot([
  { id: "p1", content: "original", impressions: 100, likes: 10 }
]);
const local = snapshot([
  { id: "p1", content: "original", impressions: 150, likes: 10 },
  { id: "p2", content: "local addition", impressions: 200, likes: 20 }
]);
const remote = snapshot([
  { id: "p1", content: "original", impressions: 100, likes: 15 },
  { id: "p3", content: "remote addition", impressions: 300, likes: 30 }
]);

const merged = mergeSnapshots(base, local, remote, {
  now: "2026-07-29T00:00:00.000Z",
  id: "merge-test"
});
assert.deepEqual(merged.data.posts.map(item => item.id).sort(), ["p1", "p2", "p3"]);
assert.equal(merged.data.posts.find(item => item.id === "p1").impressions, 150);
assert.equal(merged.data.posts.find(item => item.id === "p1").likes, 15);
assert.equal(merged.conflicts.length, 0);

const sameField = mergeSnapshots(
  snapshot([{ id: "p1", impressions: 100 }]),
  snapshot([{ id: "p1", impressions: 150 }]),
  snapshot([{ id: "p1", impressions: 140 }]),
  { now: "2026-07-29T00:00:00.000Z", id: "same-field-test" }
);
assert.equal(sameField.data.posts[0].impressions, 150);
assert.equal(sameField.conflicts.length, 1);
assert.equal(sameField.data.history[0].action, "自動競合統合");
assert.equal(sameField.data.history[0].before.remoteConflicts[0].remoteValue, 140);

const deletedLocally = mergeSnapshots(
  snapshot([{ id: "p1", impressions: 100 }]),
  snapshot([]),
  snapshot([{ id: "p1", impressions: 100 }])
);
assert.equal(deletedLocally.data.posts.length, 0);

const editedWhileRemoteDeleted = mergeSnapshots(
  snapshot([{ id: "p1", impressions: 100 }]),
  snapshot([{ id: "p1", impressions: 180 }]),
  snapshot([])
);
assert.equal(editedWhileRemoteDeleted.data.posts[0].impressions, 180);
assert.equal(editedWhileRemoteDeleted.conflicts.length, 1);

const manyLocal = Array.from({ length: 20 }, (_, index) => ({
  id: "local-" + index,
  impressions: index
}));
const largeRecovery = mergeSnapshots(
  snapshot([{ id: "local-0", impressions: 0 }]),
  snapshot(manyLocal),
  snapshot([
    { id: "local-0", impressions: 0 },
    { id: "remote-only", impressions: 999 }
  ])
);
assert.equal(largeRecovery.data.posts.length, 21);

let shared = snapshot([]);
for (let round = 0; round < 100; round += 1) {
  const machineABase = JSON.parse(JSON.stringify(shared));
  const machineBBase = JSON.parse(JSON.stringify(shared));
  const machineA = JSON.parse(JSON.stringify(machineABase));
  const machineB = JSON.parse(JSON.stringify(machineBBase));
  machineA.posts.push({
    id: "machine-a-" + round,
    content: "A-" + round,
    impressions: round
  });
  machineB.posts.push({
    id: "machine-b-" + round,
    content: "B-" + round,
    impressions: round
  });
  shared = mergeSnapshots(machineBBase, machineB, machineA).data;
}
assert.equal(shared.posts.length, 200);
assert.equal(new Set(shared.posts.map(item => item.id)).size, 200);

console.log("sync engine merge tests passed");
