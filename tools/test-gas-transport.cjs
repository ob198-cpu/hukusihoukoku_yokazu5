const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const transport=require('../backend/gas-transport.js');
const endpoint='https://script.google.com/macros/s/test/exec';
function fixture(){
  const listeners=new Set();const timers=new Map(),frames=[];let n=0;
  const win={location:{origin:'https://ob198-cpu.github.io'},crypto:{getRandomValues:b=>b.fill(7)},
    setTimeout:fn=>{timers.set(++n,fn);return n;},clearTimeout:id=>timers.delete(id),
    addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  const doc={createElement:()=>({contentWindow:{},setAttribute(){},remove(){this.removed=true;}}),body:{appendChild:f=>frames.push(f)}};
  const client=transport.create({window:win,document:doc});
  const sent=[];
  const start=(systemKey='yokazu5')=>{
    const promise=client.request(endpoint,{systemKey,action:'loadData'});
    const frame=frames.at(-1),token=new URL(frame.src).searchParams.get('channelToken');
    const peer={parent:frame.contentWindow,postMessage:(data,origin)=>sent.push({data,origin})};
    const event=(type,extra={},source=peer,origin='https://abc-script.googleusercontent.com')=>listeners.forEach(listener=>listener({source,origin,data:{channel:'sns-sheet-v1',token,type,...extra}}));
    return {promise,frame,token,peer,event};
  };
  return {client,start,sent,timers,frames};
}
test('bridge returns the unchanged JSON response and uses an exact target origin',async()=>{
  const f=fixture(),s=f.start();s.event('ready');await Promise.resolve();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].origin,'https://abc-script.googleusercontent.com');
  s.event('result',{id:f.sent[0].data.id,result:'{"ok":true,"data":{}}'});
  assert.equal(await s.promise,'{"ok":true,"data":{}}');assert.equal(f.timers.size,0);f.client.close();
});
test('wrong origin, sibling frame and wrong channel token cannot bind a bridge',async()=>{
  const f=fixture(),s=f.start();
  s.event('ready',{},s.peer,'https://attacker.example');s.event('ready',{},{});s.event('ready',{token:'wrong'});
  await Promise.resolve();assert.equal(f.sent.length,0);
  s.event('ready');await Promise.resolve();s.event('result',{id:'1',result:'ok'});assert.equal(await s.promise,'ok');f.client.close();
});
test('responses for another request are ignored',async()=>{
  const f=fixture(),s=f.start();s.event('ready');await Promise.resolve();
  s.event('result',{id:'other',result:'wrong'});assert.equal(f.timers.size,1);
  s.event('result',{id:'1',result:'correct'});assert.equal(await s.promise,'correct');f.client.close();
});
test('handshake timeout rejects and permits a fresh connection',async()=>{
  const f=fixture(),s=f.start();const rejected=assert.rejects(s.promise,/接続/);[...f.timers.values()][0]();await rejected;
  assert(s.frame.removed);const next=f.start();assert.equal(f.frames.length,2);next.event('ready');await Promise.resolve();next.event('result',{id:'1',result:'ok'});await next.promise;f.client.close();
});
test('lost response rejects instead of claiming saved or resending through another protocol',async()=>{
  const f=fixture(),s=f.start();s.event('ready');await Promise.resolve();
  const rejected=assert.rejects(s.promise,/保存結果/);[...f.timers.values()][0]();await rejected;
  assert.equal(f.sent.length,1);assert(s.frame.removed);
});
test('invalid endpoint is rejected before mounting a frame',()=>{
  const f=fixture();assert.throws(()=>f.client.request('https://attacker.example/exec',{}),/ENDPOINT/);assert.equal(f.frames.length,0);
});
function server(){
  const calls=[];let shown='';
  const ctx=vm.createContext({JSON,Error,recordSaveEnabled_:key=>['yokazu5','yokazu6'].includes(key),doPost:e=>{calls.push(JSON.parse(e.postData.contents));return {getContent:()=>'{"ok":true}'};},
    HtmlService:{XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},createHtmlOutputFromFile:name=>({getContent:()=> 'const config="__BRIDGE_CONFIG__";'}),
      createHtmlOutput:html=>{shown=html;return {setXFrameOptionsMode:mode=>({html,mode})};}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend/Bridge.gs'),'utf8'),ctx);
  return {ctx,calls,shown:()=>shown};
}
test('server bridge delegates only Hatchobori load and ID-save to the existing API',()=>{
  const f=server();for(const action of ['loadData','saveChanges'])assert.equal(f.ctx.snsBridgeRequest(JSON.stringify({systemKey:'yokazu5',action})),'{"ok":true}');
  assert.equal(f.calls.length,2);
  for(const request of [{systemKey:'yokazu6',action:'loadData'},{systemKey:'yokazu5',action:'saveData'},{systemKey:'yokazu5',action:'archiveBrowserData'}])assert.throws(()=>f.ctx.snsBridgeRequest(JSON.stringify(request)),/TARGET/);
  assert.equal(f.calls.length,2);
});
test('bridge HTML validates the parent origin, office and cryptographic channel token',()=>{
  const f=server(),good={systemKey:'yokazu5',parentOrigin:'https://ob198-cpu.github.io',channelToken:'a'.repeat(48)};
  assert.equal(f.ctx.sheetBridgePage_(good).mode,'ALLOWALL');assert(f.shown().includes(good.parentOrigin));
  for(const extra of [{systemKey:'yokazu4'},{parentOrigin:'https://attacker.example'},{parentOrigin:'https://ob198-cpu.github.io.attacker.example'},{channelToken:'<script>'}])assert.throws(()=>f.ctx.sheetBridgePage_({...good,...extra}),/TARGET/);
});
test('offices sharing an endpoint use separate iframe connections and response identities',async()=>{
 const f=fixture(),a=f.start('yokazu5'),b=f.start('yokazu6');
 assert.equal(f.frames.length,2);assert.equal(new URL(b.frame.src).searchParams.get('systemKey'),'yokazu6');
 a.event('ready');b.event('ready');await Promise.resolve();
 a.event('result',{id:'1',result:'office5'});b.event('result',{id:'1',result:'office6'});
 assert.equal(await a.promise,'office5');assert.equal(await b.promise,'office6');f.client.close();
});
test('enabled office must match the bridge-bound target; disabled office is rejected',()=>{
 const f=server();assert.equal(f.ctx.snsBridgeRequest(JSON.stringify({systemKey:'yokazu6',action:'loadData'}),'yokazu6'),'{"ok":true}');
 for(const [requested,bound] of [['yokazu6','yokazu5'],['yokazu5','yokazu6'],['yokazu4','yokazu4']])assert.throws(()=>f.ctx.snsBridgeRequest(JSON.stringify({systemKey:requested,action:'loadData'}),bound),/TARGET/);
 assert.equal(f.calls.length,1);
});
test('oversize or non-text server payload is rejected before the save handler',()=>{
  const f=server();for(const value of [{},'x'.repeat(8*1024*1024+1)])assert.throws(()=>f.ctx.snsBridgeRequest(value),/REQUEST/);assert.equal(f.calls.length,0);
});
test('embedded bridge ignores cross-origin and non-parent messages; keeps request identity',()=>{
  let receive,success,failure;const sent=[],calls=[],top={postMessage:(m,origin)=>sent.push({m,origin})};
  const runner={withSuccessHandler(fn){success=fn;return this;},withFailureHandler(fn){failure=fn;return this;},snsBridgeRequest(payload){calls.push(payload);}};
  const token='a'.repeat(48),origin='https://ob198-cpu.github.io';
  const html=fs.readFileSync(path.join(__dirname,'../backend/BridgePage.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('"__BRIDGE_CONFIG__"',JSON.stringify({origin,token}));
  vm.runInNewContext(script,{window:{top,addEventListener:(_,fn)=>receive=fn},google:{script:{run:runner}}});
  const event={source:top,origin,data:{channel:'sns-sheet-v1',token,type:'request',id:'7',payload:'{}'}};
  for(const bad of [{...event,source:{}},{...event,origin:'https://evil.example'},{...event,data:{...event.data,token:'wrong'}}])receive(bad);
  assert.equal(calls.length,0);receive(event);assert.deepEqual(calls,['{}']);success('{"ok":true}');
  assert.equal(sent.at(-1).m.id,'7');assert.equal(sent.at(-1).origin,origin);
  failure(new Error('network'));assert.equal(JSON.parse(sent.at(-1).m.result).ok,false);
});
