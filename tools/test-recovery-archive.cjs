const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {backend,clone}=require('./record-save-fixture.cjs');
const {create}=require('../backend/recovery-archive.js');
const retention=require('../backend/browser-retention.js');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const key='sns_operation_report_yokazu5_v4:recovery_snapshots_v2';
function args(f,payload='[{"reason":"test","data":{"posts":[]}}]') {return {spreadsheetId:f.sheetId,requestId:'archive-test',storageKey:key,payload,digest:hash('yokazu5\n'+key+'\n'+payload)};}
test('archive is separate, exactly read back, and idempotent',()=>{
 const f=backend(),before=f.read(),a=args(f,'=formula\n'+ 'あ'.repeat(29998)+'🙂'.repeat(4));
 assert(f.api('archiveRecoveryCopy',a).ok);const sheet=f.book.getSheetByName('過去の復旧コピー'),count=sheet.getLastRow();
 assert.equal(f.api('readRecoveryCopy',a).data.payload,a.payload);assert(f.api('archiveRecoveryCopy',a).ok);assert.equal(sheet.getLastRow(),count);
 assert.deepEqual(f.read(),before);assert(f.book.writes.filter(w=>!w.sheet.startsWith('__')).every(w=>w.sheet==='過去の復旧コピー'));
});
test('wrong sheet, wrong office storage key and corrupt digest never write',()=>{
 const f=backend();for(const change of [{spreadsheetId:'wrong'},{storageKey:'sns_operation_report_yokazu6_v4:recovery_snapshots_v2'},{digest:'0'.repeat(64)}])assert.equal(f.api('archiveRecoveryCopy',{...args(f),...change}).ok,false);
 assert.equal(f.book.getSheetByName('過去の復旧コピー'),null);
});
test('header collision preserves existing content',()=>{
 const f=backend(),s=f.book.insertSheet('過去の復旧コピー');s.rows=[['existing content']];assert.equal(f.api('archiveRecoveryCopy',args(f)).ok,false);assert.deepEqual(s.rows,[['existing content']]);
});
test('all nine offices use only their own recovery key and sheet',()=>{
 const f=backend();
 for(const systemKey of ['yokazu5','yokazu7','yokazu6','yokazu4','yokazu8','yokazu','yokazu2','yokazu3','hukusihoukoku']){
  const book=f.seed(systemKey,{posts:[{id:systemKey}]}),spreadsheetId=[...f.books].find(([,b])=>b===book)[0];
  const storageKey='sns_operation_report_'+systemKey+'_v4:recovery_snapshots_v2',payload=JSON.stringify([{data:{posts:[{id:systemKey}]}}]);
  const req={systemKey,spreadsheetId,storageKey,payload,digest:hash(systemKey+'\n'+storageKey+'\n'+payload),requestId:'office-test'};
  assert(f.api('archiveRecoveryCopy',req).ok);assert.equal(f.api('readRecoveryCopy',req).data.payload,payload);
  assert.equal(book.getSheetByName('過去の復旧コピー').rows[1][2],systemKey);
 }
});
test('failed partial archive is never verified and retry appends a complete copy',()=>{
 const f=backend(),a=args(f,'x'.repeat(70000));let once=true;
 f.book.hook=({sheet,row,values})=>{if(sheet.name==='過去の復旧コピー'&&row>1&&once){once=false;sheet.rows[row-1]=clone(values[0]);throw Error('lost connection');}};
 assert.equal(f.api('archiveRecoveryCopy',a).ok,false);assert.equal(f.api('readRecoveryCopy',a).ok,false);
 assert(f.api('archiveRecoveryCopy',a).ok);assert.equal(f.api('readRecoveryCopy',a).data.payload,a.payload);
});
test('readback rejects edited content',()=>{
 const f=backend(),a=args(f);assert(f.api('archiveRecoveryCopy',a).ok);f.book.getSheetByName('過去の復旧コピー').rows[1][6]='j:changed';assert.equal(f.api('readRecoveryCopy',a).ok,false);
});
test('legacy Hiroshima recovery copies are copied without touching source or pending archives',()=>{
 const f=backend(),book=f.seed('yokazu7',{posts:[{id:'unchanged'}]});f.ctx.selectSpreadsheet_('yokazu7');
 const sheetId=[...f.books].find(([,b])=>b===book)[0],k='sns_operation_report_yokazu7_v4:recovery_snapshots_v2',raw='[{"data":{"posts":[{"id":"old"}]}}]';
 const old=book.insertSheet('BrowserArchives');old.rows=[['digest','at','systemKey','clientId','storageKey','chunkIndex','chunkCount','payloadChunk'],[hash(k+'\n'+raw),'date','yokazu7','c:x',k,1,1,'j:'+raw]];
 const before=clone(old.rows),req={systemKey:'yokazu7',spreadsheetId:sheetId,requestId:'migration'};
 const result=f.api('migrateLegacyRecoveryCopies',req);assert(result.ok);assert.equal(result.data.copied,1);assert.deepEqual(old.rows,before);
 assert.equal(f.api('loadData',{systemKey:'yokazu7'}).data.data.posts[0].id,'unchanged');
 const n=book.getSheetByName('過去の復旧コピー').getLastRow();assert(f.api('migrateLegacyRecoveryCopies',req).ok);assert.equal(book.getSheetByName('過去の復旧コピー').getLastRow(),n);
});
function client(mode='ok') {
 const f=backend(),raw='[{"data":{"posts":[{"id":"old"}]}}]',values=new Map([[key,raw],['pending','keep'],['other-office','keep']]),calls=[],status=[];
 const storage={getItem:k=>values.get(k)??null,removeItem:k=>values.delete(k)};
 const api=create({storage,recoveryKey:key,systemKey:'yokazu5',spreadsheetId:f.sheetId,digest:async s=>hash(s),ready:()=>mode!=='busy',onStatus:s=>status.push(s),request:async(action,p)=>{
  calls.push(action);if(mode==='offline')throw Error('offline');const result=f.api(action,p);if(!result.ok)throw Error(result.error);
  if(action==='readRecoveryCopy') {if(mode==='mismatch')result.data.payload='wrong';if(mode==='other')result.data.systemKey='yokazu6';if(mode==='race')values.set(key,'new recovery');}
  return result.data;
 }});return {api,values,calls,status,raw};
}
test('client removes only exact copy after independent readback; never pending or another office',async()=>{
 const f=client();await f.api.run();assert.deepEqual(f.calls,['archiveRecoveryCopy','readRecoveryCopy']);assert(!f.values.has(key));assert.equal(f.values.get('pending'),'keep');assert.equal(f.values.get('other-office'),'keep');
});
for(const mode of ['offline','mismatch','other','race','busy'])test('client preserves source: '+mode,async()=>{
 const f=client(mode);await f.api.run();assert.equal(f.values.get(key),mode==='race'?'new recovery':f.raw);if(mode==='busy')assert.equal(f.calls.length,0);
});
test('volatile recovery remains until archive verified',async()=>{
 const f=client('offline');f.api.enqueue({data:{posts:[]}});await f.api.run();assert(f.api.hasVolatile());
 const good=client();good.api.enqueue({data:{posts:[]}});await good.api.run();assert(!good.api.hasVolatile());
});
test('retention cannot prune recovery before archival even if business sheet matches',()=>{
 const raw='[{"data":{"posts":[]}}]',values=new Map([[key,raw]]),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),get length(){return values.size;},key:i=>[...values.keys()][i]};
 const p=retention.create({storage,primaryKey:key.split(':')[0],baseKey:'base',recoveryKey:key,pendingPrefix:'pending',dirtyKey:'dirty',archiveRecovery:true,equal:(a,b)=>JSON.stringify(a)===JSON.stringify(b),normalize:x=>x});p.confirm({posts:[]});p.trim(true);assert.equal(values.get(key),raw);
});
