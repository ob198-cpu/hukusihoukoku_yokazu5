const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {backend,clone}=require('./record-save-fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const sync=require('../backend/record-sync.js');
const merge=require('../sync-engine.js');
function extract(from,to){const a=source.indexOf('    '+from),b=source.indexOf('    '+to,a+5);assert(a>=0&&b>a);return source.slice(a,b);}
function client(options={}) {
  const server=backend(), loaded=server.api('loadData').data;
  const storage=new Map([['office',JSON.stringify(loaded.data)],['other-office','untouched']]);
  const requests=[],state={statuses:[],retries:0,confirmations:0,scheduled:0,shown:false};
  let uid=0;
  const ctx=vm.createContext({
    console:{warn(){}},Date,JSON,Map,Set,
    STORAGE_KEY:'office',CLOUD_BASE_KEY:'office:base',CLOUD_PENDING_KEY:'office:pending:tab',CLOUD_PENDING_PREFIX:'office:pending',
    CLOUD_LEGACY_PENDING_KEY:'office:pending',CLOUD_DIRTY_MARKER_KEY:'office:dirty',
    CLOUD_RECOVERY_KEY:'office:recovery',CLOUD_API_URL:'https://script.google.com/macros/s/test/exec',
    CLOUD_SYSTEM_KEY:'yokazu5',CLOUD_SPREADSHEET_ID:server.sheetId,
    EXPECTED_BACKEND_BUILD_ID:'sns-multitenant-20260730-v1',CLOUD_CLIENT_ID:'client-test',
    CLOUD_MAX_MERGE_RETRIES:6,CLOUD_RETRY_DELAY_MS:15000,
    cloudRevision:loaded.updatedAt,cloudBaseData:clone(loaded.data),cloudSyncReady:true,
    cloudRecordSaveReady:true,cloudSyncInFlight:false,cloudConflictWaiting:false,
    cloudRetryTimer:null,cloudInitialLoadPending:false,volatilePendingCloudWrite:null,
    data:clone(loaded.data),uid:()=> 'pending-'+(++uid),
    normalizeData:input=>clone(input||{}),cloneRecord:clone,
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:key=>storage.get(key)||null,setItem:(key,value)=>{
      if(options.quota || (options.backupFailure&&key==='office:recovery'))throw Object.assign(Error('quota'),{name:'QuotaExceededError'});
      storage.set(key,value);
    },removeItem:key=>{if(options.removeFailure)throw Error('blocked');storage.delete(key);}},
    window:{SnsRecordSync:sync,SnsSyncMerge:merge,SnsBrowserRetention:require('../backend/browser-retention.js'),
      sessionStorage:{getItem:()=>{if(options.sessionFailure)throw Error('denied');return null;},setItem(){}}},
    fetch:async(_url,opts)=>{
      const req=JSON.parse(opts.body);requests.push(clone(req));
      if(options.networkError)throw new TypeError('Failed to fetch');
      const result=server.api(req.action,req);
      if(options.afterRequest)await options.afterRequest(req,result,ctx,server);
      return {ok:true,text:async()=>JSON.stringify(result)};
    },
    setCloudStatus:(text,type)=>state.statuses.push({text,type}),
    setInitialCloudLoading(){},finishInitialCloudLoading(){state.shown=true;},
    setupForms(){},renderAll(){},clearTimeout(){},startCloudRefresh(){},
    scheduleCloudSave(){state.scheduled++;},scheduleCloudReconnect(){state.retries++;},
    requestConflictResolution:async()=>{state.confirmations++;return options.choice||'';},
    confirmSubmittedDrafts(){}
  });
  for(const pair of [
    ['function readLocalJson(','function cloudEnabled('],
    ['function cloudEnabled(','function setCloudStatus('],
    ['async function cloudRequest(','function cloudDataHasRows('],
    ['function cloudDataHasRows(','function scheduleCloudSave('],
    ['function applySyncedData(','function conflictValueText('],
    ['async function flushCloudSave(','function scheduleCloudReconnect('],
    ['async function initCloudSync(','function hasActiveFormInput(']
  ])vm.runInContext(extract(...pair),ctx);
  ctx.updateStorageCapacityWarning=()=>{if(options.warningFailure)throw Error('warning render failure');};
  ctx.persistCloudBase(loaded.data,loaded.updatedAt,true);
  const save=change=>{const next=clone(ctx.data);change(next);ctx.data=next;ctx.saveData(next);};
  return {ctx,server,storage,requests,state,options,save};
}

test('quota and warning failure do not prevent ID send and verified completion',async()=>{
  const f=client({quota:true,warningFailure:true,backupFailure:true});
  f.save(n=>n.posts[0].impressions=41.53);
  assert(f.ctx.readPendingCloudWrite());
  await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,41.53);
  const sent=f.requests.find(r=>r.action==='saveChanges');
  assert(sent);assert(!Object.hasOwn(sent,'data'));assert.equal(sent.changes.length,1);
  assert.equal(f.ctx.readPendingCloudWrite(),null);
  assert.match(f.state.statuses.at(-1).text,/保存完了.*読戻し/);
  assert.equal(f.storage.get('other-office'),'untouched');
});

test('network plus quota failure retains memory and never claims durable storage or completion',async()=>{
  const f=client({networkError:true,quota:true});f.save(n=>n.posts[0].impressions=2);
  await f.ctx.flushCloudSave();
  assert.equal(f.ctx.readPendingCloudWrite().data.posts[0].impressions,2);
  assert.match(f.state.statuses.at(-1).text,/この画面だけ/);
  assert(!f.state.statuses.some(s=>s.type==='ok'||/保全済み|退避済み/.test(s.text)));
  assert(f.state.scheduled>0);
  f.options.networkError=false;
  await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,2);
  assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('network failure with durable pending is recoverable without relying on memory',async()=>{
  const f=client({networkError:true});f.save(n=>n.posts[0].impressions=2);
  await f.ctx.flushCloudSave();f.ctx.volatilePendingCloudWrite=null;
  assert.equal(f.ctx.readPendingCloudWrite().data.posts[0].impressions,2);
  assert(f.ctx.readPendingCloudWrite().baseData);
  assert.match(f.state.statuses.at(-1).text,/端末に退避済み/);
});

for(const bad of ['mismatch','other-office','wrong-sheet','wrong-receipt','not-verified']) {
  test('unverified reply retains pending: '+bad,async()=>{
    const f=client({afterRequest(req,result){if(req.action!=='saveChanges')return;
      if(bad==='mismatch')result.data.data.posts[0].impressions=999;
      if(bad==='other-office')result.data.systemKey='yokazu6';
      if(bad==='wrong-sheet')result.data.spreadsheetId='wrong';
      if(bad==='wrong-receipt')result.data.requestId='old-request';
      if(bad==='not-verified')result.data.verified=false;
    }});
    f.save(n=>n.posts[0].impressions=2);await f.ctx.flushCloudSave();
    assert.equal(f.ctx.readPendingCloudWrite().data.posts[0].impressions,2);
    assert(!f.state.statuses.some(s=>/保存完了/.test(s.text)));
  });
}

test('edit made while a request is in flight is sent next, without losing server-only rows',async()=>{
  let f,once=true;
  f=client({afterRequest(req){if(req.action==='saveChanges'&&once){once=false;f.save(n=>n.posts[0].impressions=3);}}});
  const remote=f.server.read(),next=clone(remote);next.posts.push({id:'remote'});
  f.server.request(sync.diff(remote,remote,next));
  f.save(n=>n.posts[0].impressions=2);await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,3);
  assert(f.server.read().posts.some(p=>p.id==='remote'));
  assert.equal(f.state.confirmations,0);assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('same-field conflict pauses for explicit choice and keeps the pending edit',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  const remote=f.server.read(),next=clone(remote);next.posts[0].impressions=3;
  f.server.request(sync.diff(remote,remote,next));
  await f.ctx.flushCloudSave();
  assert.equal(f.state.confirmations,1);assert.equal(f.server.read().posts[0].impressions,3);
  assert.equal(f.ctx.readPendingCloudWrite().data.posts[0].impressions,2);
  assert.equal(f.ctx.cloudConflictWaiting,true);
  assert(!f.state.statuses.some(s=>/保存完了/.test(s.text)));
});

test('different-field conflict is merged without discarding either edit',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  const remote=f.server.read(),next=clone(remote);next.posts[0].content='server edit';
  f.server.request(sync.diff(remote,remote,next));await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].content,'server edit');
  assert.equal(f.server.read().posts[0].impressions,2);
  assert.equal(f.state.confirmations,0);assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('unsupported backend never falls back to whole-snapshot sending',async()=>{
  const f=client();f.ctx.cloudRecordSaveReady=false;f.save(n=>n.posts[0].impressions=2);
  await f.ctx.flushCloudSave();assert.equal(f.requests.length,0);assert(f.ctx.readPendingCloudWrite());
});

test('missing base fails closed without erasing or transmitting the pending input',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);f.ctx.volatilePendingCloudWrite.baseData=null;
  await f.ctx.flushCloudSave();assert.equal(f.requests.length,0);
  assert.match(f.state.statuses.at(-1).text,/保存元を確認できない/);
  assert(f.ctx.readPendingCloudWrite());
});

test('startup backup/session failure is independent of sheet load and next save',async()=>{
  const f=client({quota:true,sessionFailure:true});f.ctx.cloudSyncReady=false;
  await f.ctx.initCloudSync();assert.equal(f.ctx.cloudSyncReady,true);assert.equal(f.ctx.cloudRecordSaveReady,true);
  f.save(n=>n.posts[0].impressions=2);await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,2);
});

test('startup pending conflict asks the user instead of silently taking the device value',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  const remote=f.server.read(),next=clone(remote);next.posts[0].impressions=3;
  f.server.request(sync.diff(remote,remote,next));f.ctx.cloudSyncReady=false;
  await f.ctx.initCloudSync();assert.equal(f.state.confirmations,1);
  assert.equal(f.ctx.cloudSyncReady,true);
  assert.equal(f.server.read().posts[0].impressions,3);assert(f.ctx.readPendingCloudWrite());
});

test('storage access denied cannot abort client identification or page bootstrap',()=>{
  const a=source.indexOf('    const CLOUD_CLIENT_ID ='),b=source.indexOf('    const businesses =',a);
  const ctx=vm.createContext({Date,Math,CLOUD_CLIENT_ID_KEY:'client',STORAGE_KEY:'office',
    localStorage:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}},
    defaultAccounts:()=>[],normalizeData:x=>x});
  vm.runInContext(source.slice(a,b),ctx);
  vm.runInContext(extract('function loadData(','function readLocalJson('),ctx);
  assert.equal(vm.runInContext('CLOUD_CLIENT_ID.startsWith("client_")',ctx),true);
  assert.deepEqual(clone(ctx.loadData()),{accounts:[]});
});

test('actual UI normalization keeps raw baseline for server compare and preserves decimals',async()=>{
  const f=client();Object.assign(f.ctx,{businesses:['自事業所'],snsTypes:['X','Instagram','TikTok','Threads','YouTube'],
    postTypes:['画像','動画','文章','リール','その他'],engagementFields:['likes','comments','shares','saves','profileAccesses','linkClicks'],
    videoMetricFields:['videoDuration','totalWatchTime','averageWatchTime','averageViewRate'],
    defaultAccounts:()=>[],todayIso:()=> '2026-10-09',weekRangeFromStart:()=>({start:'2026-10-04',end:'2026-10-10'})});
  vm.runInContext(extract('function normalizeWeeklyRecord(','function loadData('),f.ctx);
  f.ctx.data=f.ctx.normalizeData(f.server.read());
  f.save(n=>{n.posts[0].totalWatchTime=41.53;n.posts[0].averageWatchTime=8.25;});
  await f.ctx.flushCloudSave();
  assert.equal(f.ctx.readPendingCloudWrite(),null);
  assert.equal(f.server.read().posts[0].totalWatchTime,41.53);
  assert.equal(f.requests.find(r=>r.action==='saveChanges').changes.length,1);
});

test('a newer confirmed input supersedes an older durable queue when quota blocked the newer backup',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  const older=f.ctx.readPendingCloudWrite().id;
  f.options.quota=true;f.save(n=>n.posts[0].impressions=3);
  assert(f.ctx.readPendingCloudWrite().supersedes.includes(older));
  await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,3);
  assert.equal(f.ctx.readPendingCloudWrite(),null);
  assert.equal(f.storage.get('other-office'),'untouched');
});

for(const choice of ['local','remote'])test('explicit conflict choice is applied and read back: '+choice,async()=>{
  const f=client({choice});f.save(n=>n.posts[0].impressions=2);
  const remote=f.server.read(),next=clone(remote);next.posts[0].impressions=3;
  f.server.request(sync.diff(remote,remote,next));await f.ctx.flushCloudSave();
  assert.equal(f.server.read().posts[0].impressions,choice==='local'?2:3);
  assert.equal(f.state.confirmations,1);assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('legacy pending cannot use a newer shared base to infer deletion of remote-only records',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  delete f.ctx.volatilePendingCloudWrite.baseData;
  const remote=f.server.read(),next=clone(remote);next.posts.push({id:'keep-remote'});
  f.server.request(sync.diff(remote,remote,next));
  const loaded=f.server.api('loadData').data;
  f.ctx.persistCloudBase(loaded.data,loaded.updatedAt);
  f.storage.set('office:base',JSON.stringify({data:loaded.data,revision:loaded.updatedAt}));
  await f.ctx.initCloudSync();
  assert(f.ctx.readPendingCloudWrite());
  assert(f.server.read().posts.some(p=>p.id==='keep-remote'));
  assert.equal(f.requests.filter(r=>r.action==='saveChanges').length,0);
});

test('legacy pending with its matching baseline can be resent safely',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=2);
  delete f.ctx.volatilePendingCloudWrite.baseData;
  await f.ctx.initCloudSync();
  assert.equal(f.server.read().posts[0].impressions,2);
  assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('a single edit stores only its ID and before/after values regardless of sheet growth',()=>{
  const f=client();const large=clone(f.ctx.data);
  large.posts.push(...Array.from({length:3000},(_,i)=>({id:'old-'+i,content:'s'.repeat(1000)})));
  f.ctx.persistCloudBase(large,'large',true);f.ctx.data=large;
  f.save(n=>n.posts[0].impressions=9);
  const raw=f.storage.get('office:pending:tab'),stored=JSON.parse(raw);
  assert.equal(stored.format,'record-changes-v1');assert.equal(stored.changes.length,1);
  assert(!('data'in stored));assert(!('baseData'in stored));assert(raw.length*2<4096);
  assert(f.ctx.pendingIsDurable(f.ctx.readPendingCloudWrite()));
});

test('compact pending restores and resends without any full dataset cache',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=12);
  f.ctx.volatilePendingCloudWrite=null;f.ctx.cloudBaseData=null;f.ctx.data={};
  f.storage.delete('office');f.storage.delete('office:base');
  await f.ctx.initCloudSync();
  assert.equal(f.server.read().posts[0].impressions,12);assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('compact reload keeps remote-only records and detects conflicts using stored before values',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=12);
  const remote=f.server.read(),next=clone(remote);next.posts[0].impressions=13;next.posts.push({id:'remote-added'});
  f.server.request(sync.diff(remote,remote,next));
  f.ctx.volatilePendingCloudWrite=null;f.ctx.cloudBaseData=null;f.ctx.data={};
  f.storage.delete('office');f.storage.delete('office:base');await f.ctx.initCloudSync();
  assert.equal(f.state.confirmations,1);assert(f.ctx.readPendingCloudWrite());
  assert.equal(f.server.read().posts[0].impressions,13);assert(f.server.read().posts.some(x=>x.id==='remote-added'));
});

test('compact reload preserves additions and explicit deletions without a cache',async()=>{
  const f=client();f.save(n=>{n.posts=[];n.followers.push({id:'new-follower',followers:12});});
  f.ctx.volatilePendingCloudWrite=null;f.ctx.cloudBaseData=null;f.ctx.data={};
  f.storage.delete('office');f.storage.delete('office:base');await f.ctx.initCloudSync();
  assert.equal(f.server.read().posts.length,0);assert(f.server.read().followers.some(x=>x.id==='new-follower'));
  assert.equal(f.ctx.readPendingCloudWrite(),null);
});

test('invalid compact queue survives subsequent edits without being overwritten',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=12);
  const stored=JSON.parse(f.storage.get('office:pending:tab'));stored.spreadsheetId='other-sheet';
  const original=JSON.stringify(stored);f.storage.set('office:pending:tab',original);f.ctx.volatilePendingCloudWrite=null;
  assert(f.ctx.readPendingCloudWrite().invalid);f.save(n=>n.posts[0].impressions=14);f.save(n=>n.posts[0].impressions=15);
  await f.ctx.flushCloudSave();
  assert.equal(f.storage.get('office:pending:tab'),original);assert.equal(f.ctx.readPendingCloudWrite().data.posts[0].impressions,15);
  assert.equal(f.requests.length,0);
});

test('old full snapshot queue still migrates without loss',async()=>{
  const f=client();f.save(n=>n.posts[0].impressions=6);
  const legacy=clone(f.ctx.readPendingCloudWrite());delete legacy.storageKey;
  f.storage.delete('office:pending:tab');f.storage.set('office:pending',JSON.stringify(legacy));
  f.ctx.volatilePendingCloudWrite=null;await f.ctx.initCloudSync();
  assert.equal(f.server.read().posts[0].impressions,6);assert.equal(f.ctx.readPendingCloudWrite(),null);
});
