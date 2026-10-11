const {test}=require('node:test');
const assert=require('node:assert/strict');
const retention=require('../backend/browser-retention.js');
const {equal}=require('../backend/record-sync.js');
function fixture(options={}) {
  const map=new Map(), state={quota:Infinity,deny:false};
  const storage={get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,
    setItem(k,v){if(state.deny)throw Error('denied');const next=new Map(map);next.set(k,v);
      if([...next].reduce((n,[key,value])=>n+2*(key.length+value.length),0)>state.quota)throw Error('quota');map.set(k,v);},
    removeItem(k){if(state.deny)throw Error('denied');map.delete(k);}};
  const policy=retention.create({storage,primaryKey:'office',baseKey:'office:base',recoveryKey:'office:recovery',
    pendingPrefix:'office:pending',dirtyKey:'office:dirty',normalize:x=>x,equal,...options});
  return {map,state,policy,put:(k,v)=>map.set(k,JSON.stringify(v)),get:k=>JSON.parse(map.get(k)||'null')};
}
const data=value=>({posts:[{id:'a',value}]});
test('only sheet-confirmed copies are evicted to make room for protected input',()=>{
  const f=fixture();f.put('office',data(1));f.put('office:base',{data:data(1),revision:'r'});
  f.put('office-other',{keep:1});f.put('office:pending:other',{id:'other',data:data(7),baseData:data(1)});
  f.policy.confirm(data(1));f.state.quota=720;
  assert(f.policy.writeProtected('office:pending:tab',{id:'p',data:data('x'.repeat(120))}));
  assert.equal(f.map.has('office'),false);assert.equal(f.map.has('office:base'),false);
  assert.equal(f.get('office:pending:other').id,'other');assert.deepEqual(f.get('office-other'),{keep:1});
});
test('unverified primary, recovery, drafts, and other-tab pending are never quota victims',()=>{
  const f=fixture();for(const key of ['office','office:recovery','office:draft:other','office:pending:other'])f.put(key,{unique:key});
  const before=[...f.map];f.policy.confirm(data(1));f.state.quota=1;
  assert.equal(f.policy.writeProtected('office:pending:tab',data(2)),false);
  for(const [k,v]of before)assert.equal(f.map.get(k),v);assert(f.policy.hasFailures());
});
test('successful retry clears only that key failure',()=>{
  const f=fixture();f.state.deny=true;f.policy.writeProtected('office:pending:tab',data(2));
  f.policy.writeProtected('office:draft:tab',data(3));f.state.deny=false;
  assert(f.policy.writeProtected('office:pending:tab',data(2)));assert(f.policy.hasFailures());
  assert(f.policy.writeProtected('office:draft:tab',data(3)));assert(!f.policy.hasFailures());
});
test('saved cache stays bounded as the sheet grows; remote data is never truncated',()=>{
  const f=fixture({cacheBytes:1000});
  for(let size=1;size<=3000;size+=100){const full=data('x'.repeat(size));f.policy.confirm(full);
    f.policy.cache('office',full);f.policy.cache('office:base',{data:full,revision:String(size)});
    const bytes=[...f.map].filter(([k])=>k==='office'||k==='office:base').reduce((n,[k,v])=>n+(k.length+v.length)*2,0);
    assert(bytes<=1000);assert.equal(full.posts[0].value.length,size);}
});
test('old baseline needed by a legacy pending entry is protected',()=>{
  const f=fixture();f.put('office:base',{data:data(1),revision:'r'});
  f.put('office:pending:old',{id:'old',data:data(2),baseRevision:'r'});f.policy.confirm(data(1));
  f.state.quota=1;assert(!f.policy.writeProtected('office:draft:tab',data(3)));
  assert.equal(f.get('office:base').revision,'r');
  f.policy.confirm(data(4));assert(!f.policy.cache('office:base',{data:data(4),revision:'r2'}));
});
test('dirty-primary fallback is retained even when a matching sheet snapshot exists',()=>{
  const f=fixture();f.put('office',data(1));f.put('office:dirty',{id:'old'});f.policy.confirm(data(1));
  f.state.quota=1;f.policy.writeProtected('office:draft:tab',data(2));assert.deepEqual(f.get('office'),data(1));
});
test('recovery pruning does not discard unique unsent snapshots or malformed content',()=>{
  const f=fixture();const entries=[1,2,3,4].map(n=>({id:String(n),data:data(n)}));
  f.put('office:recovery',entries);f.policy.confirm(data(2));
  assert.deepEqual(f.get('office:recovery').map(x=>x.id),['1','3','4']);
  f.map.set('office:recovery','broken JSON');f.policy.confirm(data(3));
  assert.equal(f.map.get('office:recovery'),'broken JSON');
});
test('new recovery copies are deduplicated and bounded without dropping older unique copies',()=>{
  const f=fixture({recoveryBytes:600,recoveryCount:3});
  assert(f.policy.recover({id:'a',data:data(1)}));assert(f.policy.recover({id:'b',data:data(1)}));
  assert.equal(f.get('office:recovery').length,1);
  assert(!f.policy.recover({id:'big',data:data('x'.repeat(500))}));
  assert(f.policy.recover({id:'c',data:data(2)}));assert(f.policy.recover({id:'d',data:data(3)}));
  assert(!f.policy.recover({id:'e',data:data(4)}));assert.equal(f.get('office:recovery').length,3);
});
test('a durable pending copy does not generate a second recovery copy on every retry',()=>{
  const f=fixture();f.put('office:pending:tab',{id:'pending',data:data(1),baseData:data(0)});
  for(let i=0;i<200;i++)assert(f.policy.recover({id:String(i),data:data(1)}));
  assert(!f.map.has('office:recovery'));assert(f.map.has('office:pending:tab'));
});
test('unconfirmed old primary is not overwritten by a new remote cache',()=>{
  const f=fixture();f.put('office',data(1));f.policy.confirm(data(2));
  assert(!f.policy.cache('office',data(2)));assert.deepEqual(f.get('office'),data(1));
});
test('proof is invalidated when a different tab replaces a confirmed cache',()=>{
  const f=fixture();f.put('office',data(1));f.policy.confirm(data(1));f.put('office',data(99));
  f.state.quota=1;f.policy.writeProtected('office:pending:tab',data(2));assert.deepEqual(f.get('office'),data(99));
});
test('foreign keys cannot be written or evicted through the policy',()=>{
  const f=fixture();assert(!f.policy.writeProtected('office2:pending',data(1)));
  assert(!f.policy.cache('office2',data(1)));assert.equal(f.map.size,0);
});
