const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('inline scripts parse and playback precision remains unchanged',()=>{
 for(const script of source.matchAll(/<script\b[^>]*>([^]*?)<\/script>/g))new vm.Script(script[1]);
 for(const field of ['videoDuration','totalWatchTime','averageWatchTime']){
  const input=source.match(new RegExp('<input[^>]*name="'+field+'"[^>]*>'));
  assert.ok(input);assert.match(input[0],/step="0\.01"/);
 }
});
function extract(name,next){
 const a=source.indexOf('    '+name),b=source.indexOf('    '+next,a+5);
 assert.ok(a>=0&&b>a);return source.slice(a,b);
}
function fixture({quota=false,networkError=false,htmlError=false,wrongOffice=false}={}){
 const existing=JSON.stringify({posts:[{id:'local',content:'preserve me'}]});
 const storage=new Map([['office',existing],['office:recovery','old recovery'],['other-office','untouched']]);
 const remote={posts:[{id:'server',totalWatchTime:41.53}]};
 const state={shown:false,retries:0,warnings:0,status:'',rendered:0,requests:0};
 const context=vm.createContext({
  STORAGE_KEY:'office',CLOUD_BASE_KEY:'office:base',CLOUD_API_URL:'https://example.test/exec',
  CLOUD_SYSTEM_KEY:'yokazu5',EXPECTED_BACKEND_BUILD_ID:'build',cloudBaseData:null,cloudRevision:'',
  cloudSyncReady:false,cloudRetryTimer:null,data:{posts:[]},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{
   if(quota){const error=new Error('Quota exceeded');error.name='QuotaExceededError';throw error;}
   storage.set(key,value);
  }},
  fetch:async()=>{state.requests++;if(networkError)throw new TypeError('Failed to fetch');
   return {ok:true,text:async()=>htmlError?'<!DOCTYPE html><title>Error</title>':JSON.stringify({ok:true,data:{data:remote,updatedAt:'revision',systemKey:wrongOffice?'yokazu6':'yokazu5',backendBuildId:'build'}})};
  },
  cloudEnabled:()=>true,normalizeData:x=>x,cloneRecord:x=>JSON.parse(JSON.stringify(x)),
  updateStorageCapacityWarning:force=>{if(force)state.warnings++;},
  setCloudStatus:text=>{state.status=text;},setupForms:()=>{},renderAll:()=>{state.rendered++;},
  readPendingCloudWrite:()=>null,cloudDataHasRows:()=>false,
  clearTimeout:()=>{},startCloudRefresh:()=>{},
  finishInitialCloudLoading:()=>{state.shown=true;},setInitialCloudLoading:()=>{},
  scheduleCloudReconnect:()=>{state.retries++;}
 });
 for(const pair of [
  ['function writeLocalJson(','function localStorageUsageBytes('],
  ['function persistCloudBase(','function saveData('],
  ['async function cloudRequest(','function cloudDataHasRows('],
  ['function applySyncedData(','function mergeCloudData('],
  ['async function initCloudSync(','function hasActiveFormInput(']
 ])vm.runInContext(extract(...pair),context);
 return {context,state,storage,existing,remote};
}
test('quota failure after successful sheet read must not become a connection error',async()=>{
 const f=fixture({quota:true});await f.context.initCloudSync();
 assert.equal(f.context.cloudSyncReady,true);
 assert.equal(f.state.shown,true);assert.equal(f.state.status,'シート読込済み');
 assert.equal(f.state.retries,0);assert.equal(f.state.rendered,1);
 assert.deepEqual(JSON.parse(JSON.stringify(f.context.data)),f.remote);
 assert.equal(f.context.cloudRevision,'revision');assert.ok(f.state.warnings>=1);
 assert.equal(f.storage.get('office'),f.existing);
 assert.equal(f.storage.get('office:recovery'),'old recovery');
 assert.equal(f.storage.get('other-office'),'untouched');
});
test('normal sheet read still updates the local cache and renders',async()=>{
 const f=fixture();await f.context.initCloudSync();
 assert.equal(f.context.cloudSyncReady,true);assert.equal(f.state.shown,true);
 assert.deepEqual(JSON.parse(f.storage.get('office')),f.remote);
 assert.equal(f.state.warnings,0);assert.equal(f.state.requests,1);
});
for(const condition of ['networkError','htmlError','wrongOffice'])test(condition+' still fails closed and preserves local data',async()=>{
 const f=fixture({[condition]:true});await f.context.initCloudSync();
 assert.equal(f.context.cloudSyncReady,false);assert.equal(f.state.shown,false);
 assert.equal(f.state.retries,1);assert.equal(f.storage.get('office'),f.existing);
 assert.equal(f.storage.get('office:recovery'),'old recovery');
});
test('server-confirmed snapshots can render even when the cache cannot be written',()=>{
 const f=fixture({quota:true});f.context.applySyncedData(f.remote,true);
 assert.equal(f.state.rendered,1);assert.ok(f.state.warnings>=1);
 assert.equal(f.storage.get('office'),f.existing);
});
