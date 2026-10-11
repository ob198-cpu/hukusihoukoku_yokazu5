'use strict';
window.storageTest = {remote:null, revision:0, networkError:false, calls:[], results:[]};
// Test-only fetch replacement. CSP also disallows every outgoing connection.
window.fetch = async function(url, options) {
  if (url !== CLOUD_API_URL) throw new Error('TEST_BLOCKED_EXTERNAL_URL');
  const req=JSON.parse(options.body), test=window.storageTest;
  if(test.networkError)throw new TypeError('TEST_OFFLINE');
  test.calls.push(req.action);
  if(!test.remote)test.remote=normalizeData({posts:[{id:'test-post',date:'2026-10-11',sns:'X',content:'Synthetic post',impressions:1}],history:[]});
  if(req.action==='saveChanges'){
    test.remote=SnsRecordSync.apply(test.remote,req.changes);test.revision++;
  }else if(req.action!=='loadData')throw new Error('TEST_UNKNOWN_ACTION');
  return {ok:true,text:async()=>JSON.stringify({ok:true,data:{data:test.remote,
    updatedAt:'test-'+test.revision,systemKey:CLOUD_SYSTEM_KEY,spreadsheetId:CLOUD_SPREADSHEET_ID,
    backendBuildId:EXPECTED_BACKEND_BUILD_ID,recordSaveVersion:1,verified:true,requestId:req.requestId}})};
};
