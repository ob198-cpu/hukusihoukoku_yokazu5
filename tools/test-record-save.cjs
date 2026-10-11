const {test}=require('node:test');
const assert=require('node:assert/strict');
const {backend,clone}=require('./record-save-fixture.cjs');
const sync=require('../backend/record-sync.js');
function edit(f, transform){const base=f.read(),next=clone(base);transform(next);return sync.diff(base,base,next);}

test('an unset Apps Script spreadsheet timezone uses the Sheets UTC default',()=>{
  const f=backend();f.book.coerceDates=true;f.book.getSpreadsheetTimeZone=()=>'';
  assert.equal(f.request(edit(f,n=>n.posts[0].date='2026-10-11')).ok,true);
});

test('Sheets date conversion supports readback, retry and rollback without accepting changed dates',()=>{
  const f=backend();f.book.coerceDates=true;
  const ops=edit(f,n=>{n.posts[0].date='2026-10-11';n.posts[0].weekStart='2026-10-11';n.posts[0].weekEnd='2026-10-17';});
  assert.equal(f.request(ops).ok,true);
  assert.equal(f.request(ops).ok,true);
  const before=f.read();let once=true;
  f.book.hook=({sheet})=>{if(sheet.name==='Followers'&&once){once=false;throw Error('failure');}};
  assert.equal(f.request(edit(f,n=>{n.posts[0].date='2026-10-12';n.followers.push({id:'f'});})).ok,false);
  assert.deepEqual(f.read(),before);assert.equal(f.properties.size,0);
  const actual={values:[{date:'2026-10-12T00:00:00.000Z'}],formulas:['']};
  const wanted={values:['2026-10-11'],formulas:['']};
  const write={name:'Posts'};
  assert.equal(f.ctx.recordCellsEqual_(actual,wanted,write),false);
  const d=(v)=>({values:['id','','',v],formulas:['','','','']});
  assert.equal(f.ctx.recordCellsEqual_(d({date:'2026-10-12T00:00:00.000Z'}),d('2026-10-11'),write),false);
  assert.equal(f.ctx.recordCellsEqual_(d({date:'2026-10-11T00:00:00.000Z'}),d('2026-10-11'),write),true);
});

test('writes and reads back changed rows without replacing sheets or unrelated rows',()=>{
  const f=backend(), posts=f.book.getSheetByName('Posts'), id=posts.id;
  const ops=edit(f,n=>{n.posts[0].impressions=41.53;n.posts.push({id:'new',content:'new'});});
  const result=f.request(ops);
  assert.equal(result.ok,true);assert.equal(result.data.verified,true);
  assert.equal(result.data.data.posts[0].impressions,41.53);
  assert.equal(posts.id,id);assert.equal(f.book.getSheetByName('Posts'),posts);
  assert(f.book.writes.filter(w=>!w.sheet.startsWith('__record_tx_')).every(w=>['Posts','State','SyncHistory'].includes(w.sheet)));
  assert.equal(f.properties.size,0);
  assert(![...f.book.sheets.keys()].some(n=>n.startsWith('__record_tx_')));
});

test('other office data and IDs survive; missing or wrong target is rejected',()=>{
  const f=backend();const other=f.seed('yokazu6',{posts:[{id:'private',content:'untouched'}]});
  const before=clone([...other.sheets].map(([name,s])=>[name,s.rows]));
  const ops=edit(f,n=>n.posts[0].impressions=2);
  assert.equal(f.request(ops,{systemKey:'yokazu6'}).ok,false);
  assert.equal(f.request(ops,{systemKey:''}).ok,false);
  assert.equal(f.request(ops,{spreadsheetId:'wrong'}).ok,false);
  assert.equal(f.request(ops).ok,true);
  assert.deepEqual([...other.sheets].map(([name,s])=>[name,s.rows]),before);
});

test('stale snapshots modify only their IDs and same-ID conflicts do not partly save',()=>{
  const f=backend();const ops=edit(f,n=>{n.posts[0].impressions=2;n.posts.push({id:'second'});});
  assert.equal(f.request(edit(f,n=>n.posts.push({id:'server-only'}))).ok,true);
  assert.equal(f.request(ops).ok,true);
  assert.equal(f.read().posts.length,3);
  const conflict=clone(ops);conflict[0].after.impressions=3;
  conflict.push({collection:'posts',key:'id:never',before:null,after:{id:'never'}});
  assert.match(f.request(conflict).error,/CONFLICT/);
  assert(!f.read().posts.some(p=>p.id==='never'));
});

test('retry after lost response does not duplicate rows or erase a newer update',()=>{
  const f=backend();const ops=edit(f,n=>n.posts.push({id:'new'}));
  assert.equal(f.request(ops).ok,true);assert.equal(f.request(ops).ok,true);
  assert.equal(f.read().posts.filter(p=>p.id==='new').length,1);
  assert.equal(f.request(edit(f,n=>n.posts.find(p=>p.id==='new').content='later')).ok,true);
  assert.match(f.request(ops).error,/CONFLICT/);
});

test('failure halfway through a multi-row save restores all original rows',()=>{
  const f=backend(), original=f.read();
  const ops=edit(f,n=>{n.posts[0].impressions=2;n.followers.push({id:'f',followers:8});});
  let once=true;
  f.book.hook=({sheet})=>{if(sheet.name==='Followers'&&once){once=false;throw Error('write failure');}};
  assert.equal(f.request(ops).ok,false);
  f.book.hook=null;
  assert.deepEqual(f.read(),original);
  assert.equal(f.properties.size,0);
  assert.equal(f.request(ops).ok,true);
});

test('pending transaction survives failed rollback and is recovered on the next request',()=>{
  const f=backend(), original=f.read();
  const ops=edit(f,n=>{n.posts[0].impressions=2;n.followers.push({id:'f',followers:8});});
  let failing=false;
  f.book.hook=({sheet})=>{if(sheet.name==='Followers')failing=true;if(failing&&!sheet.name.startsWith('__record_tx_'))throw Error('offline');};
  assert.equal(f.request(ops).ok,false);
  assert(f.properties.has('SNS_RECORD_TRANSACTION_yokazu5'));
  f.book.hook=null;
  assert.deepEqual(f.read(),original);
  assert.equal(f.properties.size,0);
});

test('unexpected edit during recovery is preserved and recovery stops',()=>{
  const f=backend();const ops=edit(f,n=>{n.posts[0].impressions=2;n.followers.push({id:'f'});});
  f.book.hook=({sheet})=>{if(sheet.name==='Followers'){
    f.book.getSheetByName('Posts').rows[1][9]='manual external edit';throw Error('failure');
  }};
  assert.equal(f.request(ops).ok,false);
  f.book.hook=null;
  assert.match(f.api('loadData').error,/RECORD_RECOVERY_CONFLICT/);
  assert.equal(f.book.getSheetByName('Posts').rows[1][9],'manual external edit');
});

test('optional sync-history failure does not block a confirmed business save',()=>{
  const f=backend();const ops=edit(f,n=>n.posts[0].impressions=2);
  f.book.hook=({sheet})=>{if(sheet.name==='SyncHistory')throw Error('history unavailable');};
  const result=f.request(ops);
  assert.equal(result.ok,true);assert.equal(result.data.verified,true);
  assert.equal(f.read().posts[0].impressions,2);
});

test('deleted row leaves unrelated row positions intact and no phantom record',()=>{
  const f=backend();f.request(edit(f,n=>n.posts.push({id:'keep'})));
  const posts=f.book.getSheetByName('Posts'),before=clone(posts.rows[2]);
  assert.equal(f.request(edit(f,n=>n.posts.splice(0,1))).ok,true);
  assert.deepEqual(f.read().posts,[{id:'keep'}]);
  assert.deepEqual(posts.rows[2],before);
});

test('audit history omitted by UI remains available and newest stays first',()=>{
  const f=backend();const history=(id,at)=>({id,at,action:'登録',type:'post',recordId:'p',label:'投稿',before:null,after:null});
  assert.equal(f.request(edit(f,n=>n.history.push(history('h1','2026-10-01')))).ok,true);
  const ops=edit(f,n=>{n.history=[history('h2','2026-10-09')];n.posts[0].impressions=2;});
  assert.equal(f.request(ops).ok,true);
  assert.deepEqual(f.read().history.map(h=>h.id),['h2','h1']);
});

test('legacy full-save revision checks still reject stale clients',()=>{
  const f=backend(),old=f.api('loadData').data;
  assert.equal(f.request(edit(f,n=>n.posts[0].impressions=2)).ok,true);
  assert.match(f.api('saveData',{data:old.data,expectedUpdatedAt:old.updatedAt}).error,/CONFLICT/);
  assert.equal(f.read().posts[0].impressions,2);
});

test('inconsistent physical ID and JSON cannot cause an overwrite or duplicate insert',()=>{
  const f=backend(),ops=edit(f,n=>n.posts[0].impressions=2);
  const sheet=f.book.getSheetByName('Posts');sheet.rows[1][0]='different-id';
  const before=clone(sheet.rows);
  assert.match(f.request(ops).error,/ROW_ID_MISMATCH/);
  assert.deepEqual(sheet.rows,before);
  const collision=[{collection:'posts',key:'id:different-id',before:null,after:{id:'different-id'}}];
  assert.match(f.request(collision).error,/ROW_ID_MISMATCH/);
  assert.deepEqual(sheet.rows,before);
});

test('server cell readback mismatch cannot produce a verified success',()=>{
  const f=backend(),ops=edit(f,n=>n.posts[0].impressions=2);
  let flushes=0;
  f.ctx.SpreadsheetApp.flush=()=>{if(++flushes===2)f.book.getSheetByName('Posts').rows[1][10]=999;};
  const result=f.request(ops);
  assert.equal(result.ok,false);assert.match(result.error,/READBACK/);
  assert(f.properties.has('SNS_RECORD_TRANSACTION_yokazu5'));
});

test('all existing business collections and account metadata support ID updates and deletions',()=>{
  const f=backend(),base=f.read(),next=clone(base);
  next.accounts=[{business:'office',sns:'Instagram',name:'account'}];
  for(const collection of ['workMetrics','followers','inquiries','lsteps','monitoring','agencyNotices']) {
    next[collection]=[{id:collection+'-1',date:'2026-10-09',sns:'Instagram',content:'内容',
      impressions:41.53,followers:8,current:2,previous:1,limit:200,userName:'fixture-only',month:'2026-10'}];
  }
  const changes=sync.diff(base,base,next),result=f.request(changes);
  assert.equal(result.ok,true);assert(sync.verify(result.data.data,changes));
  const current=f.read(),removed=clone(current);removed.accounts=[];
  for(const collection of ['workMetrics','followers','inquiries','lsteps','monitoring','agencyNotices']) removed[collection]=[];
  const deletes=sync.diff(current,current,removed);
  const deleted=f.request(deletes);
  assert.equal(deleted.ok,true);assert(sync.verify(deleted.data.data,deletes));
  assert.deepEqual(deleted.data.data.posts,base.posts);
});
