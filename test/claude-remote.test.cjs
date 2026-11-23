'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ClaudeBridge}=require('../src/remote/claude-bridge.cjs');
const {ClaudeUsage,script}=require('../src/remote/claude-usage.cjs');
const {buildTurns}=require('../src/remote/claude-present.cjs');

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',NEW='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function channel(){
  const items=[];let wake=null,done=false;
  return {push(m){items.push(m);wake?.();},end(){done=true;wake?.();},
    async *iter(){for(;;){if(items.length){yield items.shift();continue;}if(done)return;await new Promise(r=>{wake=r;});wake=null;}}};
}
function fakeSdk({lingers=false}={}){
  const sdk={queries:[],
    sessions:[
      {sessionId:A,summary:'Sửa lỗi đăng nhập',cwd:'C:\\Work\\App',lastModified:2000e3,gitBranch:'main',firstPrompt:'fix'},
      {sessionId:B,summary:'Viết slide',cwd:'C:\\Work\\Slides',lastModified:1000e3},
      {sessionId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',summary:'Cũ',cwd:'C:\\Old',lastModified:10,archived:true},
    ],
    messages:{[A]:[
      {type:'user',uuid:'u1',message:{role:'user',content:'<system-reminder>ignore me</system-reminder>Chạy test giúp tôi'},parent_tool_use_id:null},
      {type:'assistant',uuid:'a1',message:{id:'msg_1',role:'assistant',content:[{type:'thinking',thinking:'...'}]},parent_tool_use_id:null},
      {type:'assistant',uuid:'a2',message:{id:'msg_1',role:'assistant',content:[{type:'tool_use',id:'toolu_1',name:'Bash',input:{command:'npm test'}}]},parent_tool_use_id:null},
      {type:'user',uuid:'u2',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:'1 failing',is_error:true}]},parent_tool_use_id:null},
      {type:'assistant',uuid:'a3',message:{id:'msg_2',role:'assistant',content:[{type:'tool_use',id:'toolu_2',name:'Edit',input:{file_path:'C:\\Work\\App\\a.js'}}]},parent_tool_use_id:null},
      {type:'user',uuid:'u3',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_2',content:'ok'}]},parent_tool_use_id:null},
      {type:'assistant',uuid:'a4',message:{id:'msg_3',role:'assistant',content:[{type:'text',text:'Đã sửa.'}]},parent_tool_use_id:null},
      {type:'user',uuid:'u4',message:{role:'user',content:'Cảm ơn'},parent_tool_use_id:null},
      {type:'assistant',uuid:'a5',message:{id:'msg_4',role:'assistant',content:[{type:'text',text:'Không có gì!'}]},parent_tool_use_id:null},
    ]},
    listSessions:async({limit})=>sdk.sessions.slice(0,limit),
    getSessionInfo:async id=>sdk.sessions.find(s=>s.sessionId===id),
    getSessionMessages:async id=>sdk.messages[id]||[],
    query({prompt,options}){
      const ch=channel(),q={options,channel:ch,interrupted:false,closed:false,first:null,
        [Symbol.asyncIterator]:()=>ch.iter(),interrupt:async()=>{q.interrupted=true;},close(){q.closed=true;ch.end();}};
      // Like the real SDK, the process ends once its input stream is closed, unless it
      // lingers waiting for an 'idle' state, as a real one was seen to do.
      const input=prompt[Symbol.asyncIterator]();
      q.firstMessage=input.next().then(r=>{q.first=r.value;(async()=>{while(!(await input.next()).done);if(!lingers)ch.end();})();return r.value;});
      sdk.queries.push(q);return q;
    },
  };
  return sdk;
}
async function home(t,registry=[]){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pad-claude-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'.claude','sessions'),{recursive:true});
  for(const r of registry)await fs.writeFile(path.join(dir,'.claude','sessions',r.pid+'.json'),JSON.stringify(r));
  return dir;
}
const tick=()=>new Promise(r=>setImmediate(r));
const until=async check=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert(check(),'condition not reached');};
async function bridge(t,registry=[],{lingers=false,closeGrace=5000}={}){
  const sdk=fakeSdk({lingers}),dir=await home(t,registry);
  const b=new ClaudeBridge({home:dir,loadSdk:async()=>sdk,executable:'C:\\claude.exe',pidAlive:pid=>pid!==999,folderExists:async f=>f!=='C:\\Old',closeGrace});
  const live=[];b.on('live',e=>live.push(e));
  return {b,sdk,live,dir};
}

test('sessions list newest first, skip archived ones and mark sessions open in VS Code',async t=>{
  const {b}=await bridge(t,[{pid:42,sessionId:A,status:'busy',entrypoint:'claude-vscode'},{pid:999,sessionId:B,status:'idle',entrypoint:'cli'}]);
  const list=await b.list();
  assert.deepEqual(list.map(s=>s.id),['claude:'+A,'claude:'+B]);
  assert.equal(list[0].openElsewhere,'VS Code');assert.equal(list[0].status,'active');assert.equal(list[0].branch,'main');
  assert.equal(list[1].openElsewhere,null,'a dead process does not count as open');
  assert.deepEqual((await b.list({search:'slide'})).map(s=>s.id),['claude:'+B]);
  assert.deepEqual((await b.folders(true)).map(f=>f.path).sort(),['C:\\Work\\App','C:\\Work\\Slides']);
});
test('a transcript becomes turns: prompts start turns, tool results finish their calls, reminders are hidden',async t=>{
  const {b}=await bridge(t);
  const r=await b.read('claude:'+A);
  assert.equal(r.turns.length,2);
  const [first,second]=r.turns;
  assert.deepEqual(first.items.map(i=>i.type),['user','command','files','agent']);
  assert.equal(first.items[0].text,'Chạy test giúp tôi');
  assert.deepEqual([first.items[1].command,first.items[1].exitCode,first.items[1].output],['npm test',1,'1 failing']);
  assert.deepEqual(first.items[2].changes,[{path:'C:\\Work\\App\\a.js',kind:'update'}]);
  assert.equal(first.items[3].id,'msg_3:t0');
  assert.equal(second.items[1].text,'Không có gì!');
  await assert.rejects(b.read('claude:../../etc'),{code:'CLAUDE_SESSION'});
  await assert.rejects(b.read(A),{code:'CLAUDE_SESSION'},'ids carry the provider prefix');
  const unfinished=buildTurns([{type:'user',uuid:'u',message:{content:'go'}},{type:'assistant',uuid:'a',message:{id:'m',content:[{type:'tool_use',id:'x',name:'Bash',input:{command:'sleep 9'}}]}}]);
  assert.equal(unfinished[0].items[1].status,'interrupted','a call without a result in a finished session was cut off');
});
test('a session open in another app is never written to; the phone can branch it instead',async t=>{
  const {b,sdk}=await bridge(t,[{pid:42,sessionId:A,status:'idle',entrypoint:'claude-vscode'}]);
  await assert.rejects(b.send({threadId:'claude:'+A,text:'tiếp'}),{code:'CLAUDE_OPEN_ELSEWHERE'});
  assert.equal(sdk.queries.length,0);
  const started=b.send({threadId:'claude:'+A,text:'tiếp',fork:true});await until(()=>sdk.queries.length);
  const q=sdk.queries[0];assert.equal(q.options.resume,A);assert.equal(q.options.forkSession,true);assert.equal(q.options.cwd,'C:\\Work\\App');
  assert.equal(q.options.pathToClaudeCodeExecutable,'C:\\claude.exe');
  q.channel.push({type:'system',subtype:'init',session_id:NEW});
  assert.deepEqual(await started,{threadId:'claude:'+NEW,turnId:(await q.firstMessage).uuid});
  assert.deepEqual((await q.firstMessage).message,{role:'user',content:'tiếp'});
  q.channel.push({type:'result',subtype:'success',is_error:false,duration_ms:5});await until(()=>b.active===0);
});
test('a phone turn streams, asks each permission on the phone and never persists "always" rules',async t=>{
  const {b,sdk,live}=await bridge(t);
  const requests=[];b.on('request',r=>requests.push(r));
  const rates=[];b.on('rateLimit',r=>rates.push(r));
  await assert.rejects(b.newSession({cwd:'C:\\Windows',text:'x'}),{code:'PHONE_FOLDER'});
  const started=b.newSession({cwd:'c:\\work\\app\\',text:'Chạy test'});await until(()=>sdk.queries.length);
  const q=sdk.queries[0];assert.equal(q.options.cwd,'C:\\Work\\App','the recorded folder, not the phone spelling');assert.equal(q.options.resume,undefined);
  q.channel.push({type:'system',subtype:'init',session_id:NEW});
  const {threadId,turnId}=await started;assert.equal(threadId,'claude:'+NEW);
  assert.equal(b.active,1);await assert.rejects(b.send({threadId,text:'again'}),{code:'PHONE_THREAD_ACTIVE'});
  // streamed text and the complete message share one item id
  q.channel.push({type:'stream_event',event:{type:'message_start',message:{id:'msg_9'}},parent_tool_use_id:null});
  q.channel.push({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}},parent_tool_use_id:null});
  q.channel.push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Đang '}},parent_tool_use_id:null});
  q.channel.push({type:'assistant',message:{id:'msg_9',content:[{type:'text',text:'Đang chạy'}]},parent_tool_use_id:null});
  q.channel.push({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',utilization:0.42}});
  await until(()=>rates.length);
  const ids=live.filter(e=>['item/started','item/agentMessage/delta','item/completed'].includes(e.method)).map(e=>e.item?.id||e.itemId);
  assert.deepEqual(ids,['msg_9:t0','msg_9:t0','msg_9:t0']);
  assert.equal(live[0].method,'turn/started');assert.equal(live[0].turn.id,turnId);
  assert.equal(rates[0].utilization,0.42);
  // permission round trips
  const suggestion={type:'addRules',rules:[{toolName:'Bash',ruleContent:'npm test'}],behavior:'allow',destination:'localSettings'};
  const bash=q.options.canUseTool('Bash',{command:'npm test'},{signal:new AbortController().signal,suggestions:[suggestion],toolUseID:'toolu_7',requestId:'r1'});
  assert.equal(requests[0].kind,'command');assert.equal(requests[0].command,'npm test');assert.equal(requests[0].threadId,threadId);
  assert.throws(()=>b.answer(requests[0].id,'yolo'),{code:'PHONE_APPROVAL_INVALID'});
  b.answer(requests[0].id,'acceptForSession');
  assert.deepEqual(await bash,{behavior:'allow',updatedInput:{command:'npm test'},updatedPermissions:[{...suggestion,destination:'session'}]});
  assert.throws(()=>b.answer(requests[0].id,'accept'),{code:'PHONE_APPROVAL_GONE'});
  const edit=q.options.canUseTool('Write',{file_path:'C:\\Work\\App\\b.js',content:'x'},{signal:new AbortController().signal,toolUseID:'toolu_8',requestId:'r2'});
  assert.equal(requests[1].kind,'files');assert.deepEqual(requests[1].files,['C:\\Work\\App\\b.js']);
  b.answer(requests[1].id,'decline');assert.equal((await edit).behavior,'deny');
  const question=await q.options.canUseTool('AskUserQuestion',{questions:[]},{signal:new AbortController().signal,toolUseID:'t9',requestId:'r3'});
  assert.equal(question.behavior,'deny');assert.equal(requests.length,2,'multiple-choice questions are not sent to the phone');
  const aborted=new AbortController(),pending=q.options.canUseTool('Bash',{command:'ls'},{signal:aborted.signal,toolUseID:'t10',requestId:'r4'});
  aborted.abort();assert.equal((await pending).behavior,'deny');assert.equal(b.approvals.size,0);
  await b.interrupt(threadId);assert.equal(q.interrupted,true);
  q.channel.push({type:'result',subtype:'success',is_error:false,duration_ms:1200});
  await until(()=>b.active===0);
  const done=live.find(e=>e.method==='turn/completed');assert.equal(done.turn.status,'completed');assert.equal(done.turn.durationMs,1200);
  assert.equal(b.active,0);
});
test('the phone keeps the mode a session last ran with and never leaves Claude Code running',async t=>{
  const {b,sdk,dir}=await bridge(t,[],{lingers:true,closeGrace:20});
  const write=async(folder,id,lines)=>{const d=path.join(dir,'.claude','projects',folder);await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,id+'.jsonl'),lines.map(l=>JSON.stringify(l)).join('\n')+'\n');};
  await write('C--Work-App',A,[{type:'user',permissionMode:'default'},{type:'user',permissionMode:'auto'},
    {type:'assistant',message:{content:[{type:'text',text:'"permissionMode":"bypassPermissions"'}]}},{type:'user',permissionMode:'not-a-mode'}]);
  // A folder whose name Claude Code shortened is found by scanning.
  await write('C--Work-Slides-shortened',B,[{type:'user',permissionMode:'bypassPermissions'}]);
  assert.equal((await b.read('claude:'+A)).thread.mode,'Auto');
  const started=b.send({threadId:'claude:'+A,text:'tiếp'});await until(()=>sdk.queries.length);
  const q=sdk.queries[0];
  assert.equal(q.options.permissionMode,'auto','the mode recorded last, not a quoted one or an unknown one');
  assert.equal(q.options.allowDangerouslySkipPermissions,undefined);
  assert.equal(q.options.env,undefined,'Claude Code records the SDK as the entrypoint; the phone does not pose as another app');
  q.channel.push({type:'system',subtype:'init',session_id:A});await started;
  q.channel.push({type:'result',subtype:'success',is_error:false,duration_ms:5});
  await until(()=>q.closed);await until(()=>b.active===0);
  const branch=b.newSession({cwd:'C:\\Work\\Slides',text:'x'});await until(()=>sdk.queries.length===2);
  assert.equal(sdk.queries[1].options.permissionMode,'bypassPermissions','a new session takes the folder\'s latest mode');
  assert.equal(sdk.queries[1].options.allowDangerouslySkipPermissions,true);
  sdk.queries[1].channel.push({type:'system',subtype:'init',session_id:NEW});await branch;
  sdk.queries[1].close();await until(()=>b.active===0);
  // No recorded mode: the user's settings decide, and an unknown value means the SDK default.
  const other='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  assert.equal(await b.sessionMode(other,'C:\\Nowhere'),null);
  await fs.writeFile(path.join(dir,'.claude','settings.json'),JSON.stringify({permissions:{defaultMode:'acceptEdits'}}));
  assert.equal(await b.sessionMode(other,'C:\\Nowhere'),'acceptEdits');
  assert.equal(await b.sessionMode('../../x','C:\\Nowhere'),'acceptEdits','an invalid id reads no file');
});
test('a session VS Code hides opens in Claude Code in a terminal, others through the extension link',async t=>{
  const {b,dir}=await bridge(t,[{pid:42,sessionId:B,status:'idle',entrypoint:'cli'}]);
  const write=async(folder,id,lines)=>{const d=path.join(dir,'.claude','projects',folder);await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,id+'.jsonl'),lines.map(l=>JSON.stringify(l)).join('\n')+'\n');};
  // The first entrypoint decides, as in the extension: a phone session continued in VS Code stays hidden there.
  await write('C--Work-App',A,[{type:'queue-operation'},{type:'user',entrypoint:'sdk-ts'},{type:'user',entrypoint:'claude-vscode'}]);
  assert.deepEqual(await b.computerTarget('claude:'+A),{terminal:{file:'C:\\claude.exe',cwd:'C:\\Work\\App',sessionId:A}});
  await write('C--Work-App',A,[{type:'user',entrypoint:'claude-vscode'}]);
  assert.deepEqual(await b.computerTarget('claude:'+A),{link:'vscode://anthropic.claude-code/open?session='+A});
  await write('C--Work-Slides',B,[{type:'user',entrypoint:'sdk-ts'}]);
  await assert.rejects(b.computerTarget('claude:'+B),{code:'CLAUDE_OPEN_ELSEWHERE'},'already open in a terminal');
  await assert.rejects(b.computerTarget('claude:../x'),{code:'CLAUDE_SESSION'});
  b.runs.set(A,{});await assert.rejects(b.computerTarget('claude:'+A),{code:'PHONE_THREAD_ACTIVE'});b.runs.clear();
  const none=new ClaudeBridge({home:dir,loadSdk:async()=>({getSessionInfo:async()=>({sessionId:B,cwd:'C:\\Work\\Slides'})}),executable:null});
  await fs.rm(path.join(dir,'.claude','sessions'),{recursive:true});
  await assert.rejects(none.computerTarget('claude:'+B),{code:'CLAUDE_CLI'});
});
test('a Claude Code process that dies before starting reports a clear error',async t=>{
  const {b,sdk}=await bridge(t);
  const started=b.newSession({cwd:'C:\\Work\\Slides',text:'x'});await until(()=>sdk.queries.length);
  sdk.queries[0].channel.end();
  await assert.rejects(started,{code:'CLAUDE_START'});assert.equal(b.active,0);
});

// ---------- usage ----------
test('Claude usage merges the status line, rate-limit events and direct reads, newest first',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pad-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=1_800_000_000_000;const u=new ClaudeUsage({root,home:root,now:()=>now});
  assert.equal(await u.read(),null);
  await fs.mkdir(u.dir,{recursive:true});
  await fs.writeFile(u.file,'\uFEFF'+JSON.stringify({at:now/1000-60,rate_limits:{five_hour:{used_percentage:23.5,resets_at:now/1000+3600},seven_day:{used_percentage:41,resets_at:now/1000-5}}}));
  const fromFile=await u.read();assert.equal(fromFile.source,'statusline');
  assert.deepEqual(fromFile.windows.map(w=>[w.kind,w.usedPercent]),[['five_hour',23.5],['seven_day',0]],'a window past its reset shows as reset');
  u.fromEvent({rateLimitType:'five_hour',utilization:0.5,resetsAt:now/1000+100});
  const fromEvent=await u.read();assert.equal(fromEvent.source,'session');assert.deepEqual(fromEvent.windows,[{kind:'five_hour',usedPercent:50,resetsAt:now/1000+100}]);
  now+=1000;u.fromUsage({rate_limits_available:true,subscription_type:'pro',rate_limits:{five_hour:{utilization:70,resets_at:'2027-01-15T14:00:00Z'},seven_day:{utilization:65,resets_at:null}}});
  const direct=await u.read();assert.equal(direct.plan,'pro');assert.deepEqual(direct.windows.map(w=>w.usedPercent),[70,65]);
  assert.equal(u.fromUsage({rate_limits_available:false,rate_limits:null}),null);
});
test('the status line is added to Claude Code settings without touching other keys, and only ours is removed',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pad-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const u=new ClaudeUsage({root:path.join(root,"O'Brien $plan `whoami`",'data'),home:root});
  await fs.mkdir(path.join(root,'.claude'));
  const original='{\n  "model": "opus",\n  "theme": "dark"\n}\n';
  await fs.writeFile(u.settingsFile,original);
  assert.equal(await u.status(),'missing');
  assert.equal(await u.install(),'installed');
  const settings=JSON.parse(await fs.readFile(u.settingsFile,'utf8'));
  assert.equal(settings.model,'opus');assert.equal(settings.theme,'dark');assert.equal(settings.statusLine.type,'command');
  assert.match(settings.statusLine.command,/^powershell -NoProfile -ExecutionPolicy Bypass -File '[^\\]+statusline\.ps1'$/,'forward slashes survive Git Bash');
  const body=await fs.readFile(u.scriptFile,'utf8');assert(body.startsWith('\uFEFF'));assert(/^[\x00-\x7F]*$/.test(body.slice(1)),'the script is ASCII');
  assert.equal(await u.remove(),'missing');assert.equal(JSON.parse(await fs.readFile(u.settingsFile,'utf8')).statusLine,undefined);
  await fs.writeFile(u.settingsFile,JSON.stringify({statusLine:{type:'command',command:'echo '+u.scriptFile.replace(/\\/g,'/')}}));
  assert.equal(await u.status(),'foreign','mentioning our path does not make another command ours');
  assert.equal(await u.remove(),'foreign');
  await fs.writeFile(u.settingsFile,JSON.stringify({statusLine:{type:'command',command:'~/.claude/mine.sh'}}));
  assert.equal(await u.status(),'foreign');
  await assert.rejects(u.install(),{code:'CLAUDE_STATUSLINE_FOREIGN'});
  assert.equal(await u.remove(),'foreign');assert.equal(JSON.parse(await fs.readFile(u.settingsFile,'utf8')).statusLine.command,'~/.claude/mine.sh');
  assert.match(script('C:\\Users\\a\'b\\usage.json'),/'C:\/Users\/a''b\/usage\.json'/,'quotes and backslashes are escaped');
});

test('the status line shell command quotes spaces, apostrophes and shell expressions in its path',t=>{
  const u=new ClaudeUsage({root:'C:\\Users\\O\'Brien $name `whoami`\\PAD Switcher',home:'C:\\Users\\test'});
  const bash=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:\\Program Files','Git','bin','bash.exe'):'bash';
  // Substitute the executable, so the shell parses real arguments without running PowerShell.
  const result=require('node:child_process').spawnSync(bash,['--noprofile','--norc','-c',
    'powershell() { printf "%s\\0" "$@"; }; '+u.command],{encoding:'utf8',windowsHide:true});
  if(result.error?.code==='ENOENT'){t.skip('Bash is not installed');return;}
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.split('\0'),['-NoProfile','-ExecutionPolicy','Bypass','-File',u.scriptFile.replace(/\\/g,'/'),'']);
});
