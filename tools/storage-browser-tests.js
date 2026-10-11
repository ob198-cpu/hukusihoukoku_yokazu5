'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  const panel=document.createElement('section');panel.id='storage-test-panel';
  panel.style.cssText='position:fixed;right:8px;top:8px;z-index:99999;background:white;color:black;border:2px solid #16734b;padding:12px;max-width:640px;max-height:70vh;overflow:auto';
  panel.innerHTML='<strong>LOCAL TEST ONLY: synthetic data, external connections blocked</strong><br><button id="run-storage-tests">Run storage tests</button><pre id="storage-test-result">Ready</pre>';
  document.body.appendChild(panel);
  document.getElementById('run-storage-tests').addEventListener('click',async()=>{
    const results=storageTest.results;results.length=0;
    const output=document.getElementById('storage-test-result');
    const assert=(condition,message)=>{if(!condition)throw new Error(message);};
    const test=async(name,fn)=>{try{await fn();results.push('PASS '+name);}catch(error){results.push('FAIL '+name+': '+error.message);}
      output.textContent=results.join('\n');};
    const field=(form,name)=>document.getElementById(form).elements[name];
    const input=(element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));};
    await initCloudSync();clearInterval(cloudRefreshTimer);
    await test('draft survives form setup and same-tab recovery',()=>{
      input(field('post-form','content'),'Unsubmitted draft');
      input(field('inquiry-form','content'),'Other form draft');
      assert(readLocalJson(FORM_DRAFT_KEY).forms['post-form'],'draft not durable');
      setupForms();assert(field('post-form','content').value==='Unsubmitted draft','setup erased draft');
      formDrafts={};initFormDrafts();setupForms();
      assert(field('inquiry-form','content').value==='Other form draft','restore failed');
      assert(hasActiveFormInput(),'blurred draft not protected');
    });
    await test('cancelling one form preserves the other draft',()=>{
      discardFormDraft('post-form');
      assert(formDrafts['inquiry-form'],'other draft deleted');
      assert(readLocalJson(FORM_DRAFT_KEY).forms['inquiry-form'],'other draft not on disk');
    });
    await test('verified ID send clears only its queue and keeps unrelated input',async()=>{
      data.posts[0].impressions=17;saveData(data);clearTimeout(cloudSaveTimer);
      await flushCloudSave();clearTimeout(cloudSaveTimer);
      assert(storageTest.remote.posts[0].impressions===17,'server value');
      assert(!readPendingCloudWrite(),'queue retained');
      assert(field('inquiry-form','content').value==='Other form draft','input erased by ack');
      assert(formDrafts['inquiry-form'],'draft erased by ack');
    });
    await test('dynamic work rows and raw numeric fields survive setup',()=>{
      addWorkMetricRow();const rows=document.querySelectorAll('#work-metric-body [data-work-row]');const row=rows[0];
      input(row.querySelector('[name="workContent"]'),'New work draft');
      input(row.querySelector('[name="workValue"]'),'21');setupForms();
      const restored=[...document.querySelectorAll('#work-metric-body [name="workContent"]')].find(x=>x.value==='New work draft');
      assert(restored,'work row missing');assert(restored.closest('tr').querySelector('[name="workValue"]').value==='21','work value lost');
    });
    await test('quota failure keeps draft until exact sheet acknowledgement',async()=>{
      const write=Storage.prototype.setItem;
      try{
        Storage.prototype.setItem=function(key,value){if(key===CLOUD_PENDING_KEY)throw new DOMException('test full','QuotaExceededError');return write.call(this,key,value);};
        input(field('post-form','content'),'Quota draft');
        data.posts[0].impressions=18;saveData(data);clearTimeout(cloudSaveTimer);submitFormDraft('post-form');
        assert(formDrafts['post-form'],'draft removed before durable queue');
        assert(!document.getElementById('storage-capacity-warning').hidden,'failure hidden');
        await flushCloudSave();clearTimeout(cloudSaveTimer);
        assert(!formDrafts['post-form'],'ack did not clear submitted draft');
        assert(formDrafts['inquiry-form'],'ack deleted unrelated draft');
      }finally{Storage.prototype.setItem=write;}
    });
    await test('repeated offline retries do not grow recovery copies',async()=>{
      storageTest.networkError=true;data.posts[0].impressions=19;saveData(data);clearTimeout(cloudSaveTimer);
      for(let i=0;i<4;i++){await flushCloudSave();clearTimeout(cloudSaveTimer);}
      assert(readPendingCloudWrite().data.posts[0].impressions===19,'pending lost');
      assert((readLocalJson(CLOUD_RECOVERY_KEY,[])||[]).length===0,'duplicate recovery accumulated');
      storageTest.networkError=false;await flushCloudSave();clearTimeout(cloudSaveTimer);
      assert(!readPendingCloudWrite(),'resend failed');
    });
    await test('normal registration hands its draft to a durable queue',async()=>{
      input(field('inquiry-form','content'),'Synthetic inquiry');input(field('inquiry-form','operator'),'Test operator');
      document.getElementById('inquiry-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      clearTimeout(cloudSaveTimer);assert(!formDrafts['inquiry-form'],'draft was not handed over');
      assert(readPendingCloudWrite(),'no queued record');await flushCloudSave();clearTimeout(cloudSaveTimer);
      assert(storageTest.remote.inquiries.some(row=>row.content==='Synthetic inquiry'),'new record missing');
    });
    await test('successful save hides stale capacity warning, including computed style',()=>{
      const warning=document.getElementById('storage-capacity-warning');
      assert(warning.hidden&&getComputedStyle(warning).display==='none','stale warning still visible');
    });
    await test('work table redraw preserves unsaved rows',()=>{
      renderWorkMetricRows();
      assert([...document.querySelectorAll('#work-metric-body [name="workContent"]')].some(x=>x.value==='New work draft'),'redraw lost row');
    });
    await test('newer draft survives acknowledgement of an older submitted form',()=>{
      input(field('post-form','content'),'Newer draft');
      confirmSubmittedDrafts(new Set(['unrelated-old-id']));
      assert(formDrafts['post-form'],'newer draft erased');
      assert(field('post-form','content').value==='Newer draft','newer content erased');
    });
    await test('compact queue restores with real UI normalizers and no full cache',async()=>{
      data.posts[0].impressions=25;saveData(data);clearTimeout(cloudSaveTimer);
      assert(readLocalJson(CLOUD_PENDING_KEY).format==='record-changes-v1','not compact');
      volatilePendingCloudWrite=null;cloudBaseData=null;localStorage.removeItem(STORAGE_KEY);localStorage.removeItem(CLOUD_BASE_KEY);
      await initCloudSync();clearTimeout(cloudSaveTimer);clearInterval(cloudRefreshTimer);
      assert(storageTest.remote.posts[0].impressions===25,'rehydrated edit missing');assert(!readPendingCloudWrite(),'queue did not clear');
      assert(field('post-form','content').value==='Newer draft','unregistered form lost');
    });
    await test('unknown saved draft shape is preserved instead of overwritten',()=>{
      const saved=localStorage.getItem(FORM_DRAFT_KEY);
      try{
        localStorage.setItem(FORM_DRAFT_KEY,'{"version":999,"forms":{}}');
        initFormDrafts();input(field('post-form','content'),'Still in memory');
        assert(localStorage.getItem(FORM_DRAFT_KEY)==='{"version":999,"forms":{}}','unknown draft overwritten');
        assert(formDraftReadFailed,'unreadable draft not reported');
      }finally{formDraftReadFailed=false;localStorage.setItem(FORM_DRAFT_KEY,saved);initFormDrafts();updateStorageCapacityWarning();}
    });
    clearInterval(cloudRefreshTimer);clearTimeout(cloudSaveTimer);clearTimeout(cloudRetryTimer);
    output.textContent=results.join('\n')+'\n'+results.filter(s=>s.startsWith('PASS')).length+'/'+results.length+' passed';
  });
});
