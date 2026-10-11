const {test} = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../backend/record-sync.js');
const snapshot = posts => ({posts, history: [], accounts: []});
const p = {id:'p', content:'original', impressions:1};

test('sends only changed IDs and keeps server-only records', () => {
  const base = snapshot([p]);
  const next = snapshot([{...p, impressions:41.53}, {id:'new', content:'new'}]);
  const ops = sync.diff(base, base, next);
  assert.equal(ops.length, 2);
  const remote = snapshot([p, {id:'other-device', content:'untouched'}]);
  const result = sync.apply(remote, ops);
  assert.deepEqual(result.posts, [next.posts[0], remote.posts[1], next.posts[1]]);
  assert.equal(remote.posts[0].impressions, 1);
  assert.equal(sync.verify(result, ops), true);
});

test('same ID conflict rejects the entire batch before mutating the input', () => {
  const base = snapshot([p]);
  const ops = sync.diff(base, base, snapshot([{...p, impressions:2}, {id:'new'}]));
  const remote = snapshot([{...p, content:'another user'}]);
  assert.throws(() => sync.apply(remote, ops), /CONFLICT/);
  assert.equal(remote.posts.length, 1);
});

test('lost-response retry is idempotent; a later edit must not be overwritten', () => {
  const base = snapshot([p]);
  const ops = sync.diff(base, base, snapshot([{...p, impressions:2}]));
  const saved = sync.apply(base, ops);
  assert.deepEqual(sync.apply(saved, ops), saved);
  assert.throws(() => sync.apply(snapshot([{...p, impressions:3}]), ops), /CONFLICT/);
});

test('explicit deletion only removes its ID and conflicts with an edited row', () => {
  const base = snapshot([p]);
  const ops = sync.diff(base, base, snapshot([]));
  assert.deepEqual(sync.apply(snapshot([p,{id:'remote-new'}]), ops).posts, [{id:'remote-new'}]);
  assert.throws(() => sync.apply(snapshot([{...p, content:'changed'}]), ops), /CONFLICT/);
});

test('UI normalization does not invent edits or change the raw before value', () => {
  const raw = snapshot([{id:'p'}]);
  const view = snapshot([{id:'p', impressions:0, note:''}]);
  assert.deepEqual(sync.diff(raw, view, view), []);
  const ops = sync.diff(raw, view, snapshot([{...view.posts[0], impressions:2}]));
  assert.deepEqual(ops[0].before, {id:'p'});
  assert.equal(sync.apply(raw, ops).posts[0].impressions, 2);
});

test('no known base, ambiguous IDs and identity changes fail closed', () => {
  assert.throws(() => sync.diff(null, {}, snapshot([p])), /BASE/);
  assert.throws(() => sync.diff(snapshot([p,p]), {}, {}), /DUPLICATE/);
  assert.throws(() => sync.apply(snapshot([p]), [{collection:'posts', key:'id:p', before:p, after:{id:'other'}}]), /IDENTITY/);
  assert.throws(() => sync.apply({}, [{collection:'__proto__', key:'id:p', before:null, after:p}]), /COLLECTION/);
});

test('old audit history omitted by the UI is not deleted', () => {
  const base = {...snapshot([]), history:[{id:'h',at:'old'}]};
  const next = {...snapshot([]), history:[{id:'new-history',at:'new'}]};
  const ops = sync.diff(base, base, next);
  assert.equal(ops.length, 1);
  assert.equal(sync.apply(base, ops).history.length, 2);
});

test('readback mismatch is not a successful save', () => {
  const base = snapshot([p]);
  const ops = sync.diff(base, base, snapshot([{...p, impressions:2}]));
  assert.equal(sync.verify(base, ops), false);
});
