'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {lastMatch,codexMode,claudeMode}=require('../src/remote/modes.cjs');

async function file(t,text){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pad-modes-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const f=path.join(dir,'s.jsonl');await fs.writeFile(f,text);return f;
}
const line=o=>JSON.stringify(o)+'\n';
const filler=bytes=>{let s='';for(let i=0;s.length<bytes;i++)s+=line({type:'response_item',n:i,text:'Tiếng Việt '.repeat(20)});return s;};

test('the last matching line is found across chunk boundaries and inside very long lines',async t=>{
  // A target line that straddles the first 256 KiB boundary read from the end.
  const target=line({type:'turn_context',payload:{approval_policy:'never',sandbox_policy:{type:'danger-full-access'},note:'x'.repeat(4000)}});
  const tail=filler(256*1024-1000);
  const f=await file(t,filler(300*1024)+line({type:'turn_context',payload:{approval_policy:'on-request',sandbox_policy:{type:'read-only'}}})+target+tail);
  assert.deepEqual(await codexMode(f),{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},label:'Toàn quyền'});
  // A single line longer than a chunk.
  const huge=await file(t,line({type:'user',permissionMode:'acceptEdits',text:'y'.repeat(600*1024)})+filler(10*1024));
  assert.equal(await claudeMode(huge),'acceptEdits');
  // Nothing past the read limit is looked at.
  assert.equal(await lastMatch(f,'"turn_context"',l=>l.payload?.approval_policy,64*1024),null);
});
test('missing files, unknown values and quoted text give no mode',async t=>{
  assert.equal(await codexMode(null),null);
  assert.equal(await claudeMode(path.join(os.tmpdir(),'no-such-session.jsonl')),null);
  const f=await file(t,line({type:'turn_context',payload:{approval_policy:'sometimes',sandbox_policy:{type:'external-sandbox'}}})+line({type:'response_item',text:'{"type":"turn_context"}'})+'not json "turn_context"\n');
  assert.equal(await codexMode(f),null);
  const g=await file(t,line({type:'user',permissionMode:'auto'})+line({type:'user',permissionMode:'yolo'})+line({type:'assistant',text:'"permissionMode":"bypassPermissions"'}));
  assert.equal(await claudeMode(g),'auto');
});
