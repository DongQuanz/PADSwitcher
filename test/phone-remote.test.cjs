'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {WebSocketServer}=require('ws');
const qr=require('../src/remote/qr.cjs');
const {PhoneRemote,privateAddress,sign,PHONE_LINK}=require('../src/remote/phone-server.cjs');
const {UserError}=require('../src/core/errors.cjs');

const bits=m=>crypto.createHash('sha256').update(m.flat().map(v=>v?1:0).join('')).digest('hex');
test('QR encoder matches reference matrices and renders SVG',()=>{
  // Reference matrices are compared module by module through their hashes.
  const url='http://192.168.1.23:47860/#k=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefg';
  assert.equal(qr.encode(url).length,37);assert.equal(bits(qr.encode(url)),'3564b1c0ebd439df89cd2e421a62e2280029cfdf4122d0e9501a92b2f6fd87da');
  assert.equal(qr.encode('PADSwitcher').length,21);assert.equal(bits(qr.encode('PADSwitcher')),'b31d14afae3c07ff38be3751b6c9d2ed7c1487baac2f8fc1577bfc7d31548712');
  assert.match(qr.toSvg(qr.encode('x')),/^<svg [^>]*viewBox="0 0 29 29"/);
  assert.throws(()=>qr.encode('x'.repeat(700)),RangeError);
});
test('only loopback and private-network peers are served',()=>{
  for(const a of ['127.0.0.1','::1','::ffff:192.168.1.9','10.2.3.4','172.16.0.1','172.31.255.1','192.168.0.10','fe80::1','fd12::3'])assert.equal(privateAddress(a),true,a);
  for(const a of ['8.8.8.8','172.32.0.1','100.64.1.2','::ffff:1.1.1.1','2001:db8::1','',undefined])assert.equal(privateAddress(a),false,String(a));
});
test('phone page HMAC implementation matches Node',()=>{
  const sandbox={window:{}};new Function('window',require('node:fs').readFileSync(path.join(__dirname,'../src/remote/static/sha256.js'),'utf8'))(sandbox.window);
  for(const [k,m]of [['k','hello'],['x'.repeat(90),''],['secret-_123','POST\n/api/call\n{"text":"Tiếng Việt ✓"}'.repeat(30)]])
    assert.equal(sandbox.window.padHmac.hmac(k,m),sign(k,m));
});

// ---------- end to end against a fake gateway ----------
async function fakeGateway(t){
  const token='front-token',seen=[],threads=new Map([
    ['t-idle',{id:'t-idle',name:'Sửa lỗi đăng nhập',preview:'Fix login',cwd:'C:\\Work\\App',status:{type:'idle'},updatedAt:100,ephemeral:false,parentThreadId:null,turns:[]}],
    ['t-gone',{id:'t-gone',name:'Old',preview:'Old',cwd:'D:\\Gone',status:{type:'notLoaded'},updatedAt:80,ephemeral:false,parentThreadId:null,turns:[]}],
    ['t-busy',{id:'t-busy',name:null,preview:'Long task',cwd:'D:\\Data',status:{type:'active',activeFlags:[]},updatedAt:90,ephemeral:false,parentThreadId:null,turns:[]}],
  ]);
  const server=http.createServer();const wss=new WebSocketServer({noServer:true});let socket=null;
  server.on('upgrade',(req,s,head)=>{if(req.headers.authorization!=='Bearer '+token){s.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}wss.handleUpgrade(req,s,head,ws=>{socket=ws;ws.on('message',d=>handle(ws,JSON.parse(d)));});});
  const results={
    initialize:()=>({userAgent:'fake'}),
    'thread/list':()=>({data:[...threads.values()],nextCursor:null}),
    'thread/read':p=>({thread:threads.get(p.threadId)}),
    'thread/resume':p=>({thread:threads.get(p.threadId)}),
    'thread/turns/list':p=>({data:p.threadId==='t-busy'?[{id:'turn-9',status:'inProgress',items:[]}]:[{id:'turn-1',status:'completed',items:[{type:'userMessage',id:'i1',content:[{type:'text',text:'hi'}]},{type:'agentMessage',id:'i2',text:'Hello!'}]}],nextCursor:null}),
    'thread/start':p=>{const id='t-new';threads.set(id,{id,cwd:p.cwd,status:{type:'idle'},turns:[]});return {thread:threads.get(id)};},
    'turn/start':()=>({turn:{id:'turn-new',status:'inProgress',items:[]}}),
    'turn/interrupt':()=>({}),
  };
  function handle(ws,m){
    seen.push(m);
    if(m.method&&m.id!=null){const f=results[m.method];ws.send(JSON.stringify(f?{id:m.id,result:f(m.params||{})}:{id:m.id,error:{code:-32601,message:'unknown method '+m.method}}));}
  }
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const c of wss.clients)c.terminate();server.close();});
  return {shared:{status:'ready',url:'ws://127.0.0.1:'+server.address().port,frontToken:token},seen,threads,send:m=>socket.send(JSON.stringify(m)),get socket(){return socket;}};
}
// Claude sessions are covered by claude-bridge tests; here the phone server only routes to them.
class FakeClaude extends EventEmitter{
  constructor(){super();this.runs=new Map();this.approvals=new Map();this.calls=[];this.hidden=new Set();}
  get active(){return this.runs.size;}
  async list(){return [{id:'claude:11111111-1111-4111-8111-111111111111',provider:'claude',title:'Claude task',cwd:'C:\Work\App',status:'idle',updatedAt:95,waiting:[]}];}
  async folders(){return [{path:'C:\Claude',name:'Claude',count:1,updatedAt:1}];}
  async read(id){this.calls.push(['read',id]);return {thread:{id,provider:'claude'},turns:[],nextCursor:null,approvals:[]};}
  async send(a){this.calls.push(['send',a]);return {threadId:a.threadId,turnId:'t'};}
  async newSession(a){this.calls.push(['new',a]);return {threadId:'claude:x',turnId:'t'};}
  async interrupt(id){this.calls.push(['interrupt',id]);return {};}
  answer(id,d){this.calls.push(['answer',id,d]);}
  async usage(){return {rate_limits_available:true,subscription_type:'pro',rate_limits:{five_hour:{utilization:70,resets_at:'2030-01-01T00:00:00Z'}}};}
  async computerTarget(threadId){
    const id=String(threadId).slice('claude:'.length);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new UserError('Session không hợp lệ.','PHONE_THREAD');
    if(this.runs.has(id))throw new UserError('Chờ lượt trên điện thoại xong.','PHONE_THREAD_ACTIVE');
    return this.hidden.has(id)?{terminal:{file:'C:\\claude.exe',cwd:'C:\\Work',sessionId:id}}:{link:'vscode://anthropic.claude-code/open?session='+id};
  }
  closeAll(){}
}
function fakeService(){
  const service=new EventEmitter();
  service.state={profiles:[{id:'p1',label:'Cá nhân',plan:'plus',status:'ready',quota:[{id:'codex',name:'Codex',windows:[{kind:'primary',usedPercent:30,windowDurationMins:300,resetsAt:2e9}]}],quotaAt:new Date().toISOString(),email:'private@example.com'}]};
  service.view=()=>({version:'1.0.0',profiles:service.state.profiles,gateway:{status:'ready',profileId:'p1'},autoSwitch:{enabled:true},sayHi:{active:false}});
  service.changed=()=>service.emit('change');
  service.get=id=>{const p=service.state.profiles.find(x=>x.id===id);if(!p)throw Object.assign(new Error('missing'),{code:'PROFILE_MISSING'});return p;};
  service.refreshAll=async()=>{};service.sayHi={start:id=>({active:true,id})};
  service.platform={protectDirectory:async()=>{}};
  return service;
}
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pad-phone-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const gateway=await fakeGateway(t),service=fakeService(),selected=[],opened=[],terminals=[];
  const claude=new FakeClaude(),claudeUsage={setup:'missing',status:async()=>'missing',read:async()=>null,fromEvent(){},fromUsage(){}};
  const remote=new PhoneRemote({root,service,gateway,claude,claudeUsage,port:0,addresses:async()=>['127.0.0.1'],folderExists:async f=>f!=='D:\\Gone',actions:{selectAccount:async id=>{selected.push(id);},openLink:async url=>{assert.match(url,PHONE_LINK);opened.push(url);},openTerminal:async target=>{terminals.push(target);}}});
  await remote.start();t.after(()=>remote.stop(true));
  const base='http://127.0.0.1:'+remote.port;
  let device='device-aaaaaaaa';
  const post=async(cmd,args={},{secret=remote.pairing.secret,time=Date.now(),nonce=crypto.randomBytes(8).toString('hex'),as=device,raw=null}={})=>{
    const body=raw||JSON.stringify({cmd,args,d:as,t:time,n:nonce});
    const r=await fetch(base+'/api/call',{method:'POST',headers:{'Content-Type':'application/json','X-Pad-Signature':sign(secret,'POST\n/api/call\n'+body)},body});
    return {status:r.status,body:await r.json()};
  };
  const events=({connectionId=crypto.randomBytes(16).toString('hex')}={})=>new Promise((resolve,reject)=>{
    const t0=Date.now(),n=crypto.randomBytes(8).toString('hex'),s=sign(remote.pairing.secret,['GET','/api/events',device,t0,n,connectionId].join('\n'));
    const req=http.get(base+`/api/events?d=${device}&t=${t0}&n=${n}&s=${s}&c=${connectionId}`,res=>{
      const got=[];let buffer='';const waiters=[];
      res.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);const ev=/^event: (.*)$/m.exec(block),data=/^data: (.*)$/m.exec(block);if(ev){got.push({event:ev[1],data:JSON.parse(data[1])});for(const w of waiters.splice(0))w();}}});
      const next=async(name)=>{for(;;){const found=got.findIndex(e=>e.event===name);if(found>=0)return got.splice(found,1)[0].data;await new Promise(r=>waiters.push(r));}};
      resolve({status:res.statusCode,next,connectionId,close:()=>req.destroy()});
    });req.on('error',reject);
  });
  return {remote,gateway,service,selected,opened,terminals,post,events,base,claude,setDevice:d=>{device=d;}};
}
test('requests must be signed, fresh and unique; the first phone is bound and a new code revokes it',async t=>{
  const {remote,post}=await setup(t);
  assert.equal((await post('hello',{},{secret:'wrong'})).status,403);
  assert.equal(remote.pairing.device,null,'a failed request never binds a phone');
  assert.equal((await post('hello',{},{time:Date.now()-10*60*1000})).status,401);
  const ok=await post('hello',{},{nonce:'nonce-reused-1'});assert.equal(ok.status,200);assert.equal(ok.body.ok,true);
  assert.equal(remote.pairing.device,'device-aaaaaaaa');
  assert.equal((await post('hello',{},{nonce:'nonce-reused-1'})).status,401,'replayed request');
  const other=await post('hello',{},{as:'device-bbbbbbbb'});assert.equal(other.status,409);
  const saved=JSON.parse(await fs.readFile(remote.file,'utf8'));assert.equal(saved.device,'device-aaaaaaaa');
  const old=remote.pairing.secret;await remote.resetPairing();
  assert.equal((await post('hello',{},{secret:old})).status,403);
  assert.equal((await post('hello',{},{as:'device-bbbbbbbb'})).status,200,'a new phone can pair after a new code');
});

test('an open but unresponsive phone stream loses its connected status after the heartbeat lease',async t=>{
  const {remote,events}=await setup(t);let now=Date.now();remote.now=()=>now;
  const stream=await events();t.after(()=>stream.close());await stream.next('overview');
  assert.equal(remote.view().phoneConnected,true);
  now+=46000;remote.idle();
  assert.equal(remote.view().phoneConnected,false,'a TCP socket alone is not evidence that the phone tab is still there');
  assert.equal(remote.stream,null,'the expired stream is actually closed');
});

test('a newly shown QR grants a fresh key that old tabs cannot claim with their previous key',async t=>{
  const {remote,post}=await setup(t);await post('hello');const old=remote.pairing.secret;
  const code=await remote.qr('127.0.0.1','qr-request-aaaaaa'),url=new URL(code.url),key=new URLSearchParams(url.hash.slice(1)).get('k');
  assert.notEqual(key,old,'showing a QR issues a separate pairing capability');
  assert(url.searchParams.get('pair'),'each fresh scan navigates the browser instead of only changing its hash');
  assert.equal((await post('hello',{},{secret:old})).status,200,'the existing paired phone may still finish its work');
  assert.equal((await post('hello',{},{secret:old,as:'device-old-lostid'})).status,409,'another old tab cannot use the new QR window');
  const again=await remote.qr('127.0.0.1','qr-request-aaaaaa');assert.equal(again.url,code.url,'the same QR request can be retried without invalidating the displayed code');
  assert.equal((await post('hello',{},{secret:key,as:'device-fresh-scan'})).status,200);
  assert.equal(remote.pairing.device,'device-fresh-scan');
  assert.equal((await post('hello',{},{secret:old})).status,403);
});

test('a delayed disconnect from a previous phone tab cannot close the current stream',async t=>{
  const {remote,events,post}=await setup(t);
  const first=await events();t.after(()=>first.close());await first.next('overview');
  const second=await events();t.after(()=>second.close());await second.next('overview');
  const old=await post('disconnect',{connectionId:first.connectionId});assert.equal(old.body.ok,true);
  assert.equal(remote.view().phoneConnected,true);
  const closed=await post('disconnect',{connectionId:second.connectionId});assert.equal(closed.body.ok,true);
  assert.equal(remote.view().phoneConnected,false);
});

test('only a signed heartbeat for the current stream renews the phone lease',async t=>{
  const {remote,events,post}=await setup(t);let now=Date.now();remote.now=()=>now;
  const stream=await events();t.after(()=>stream.close());await stream.next('overview');
  now+=30000;
  assert.equal((await post('heartbeat',{connectionId:stream.connectionId})).body.result.connected,true);
  now+=30000;remote.idle();assert.equal(remote.view().phoneConnected,true,'a live tab renewed the lease');
  assert.equal((await post('heartbeat',{connectionId:'a-previous-stream'})).body.result.connected,false);
  now+=16000;remote.idle();assert.equal(remote.view().phoneConnected,false,'an old tab cannot renew another stream');
});

test('the heartbeat lease closes the stream on time without waiting for the next periodic poll',async t=>{
  const {remote,events,post}=await setup(t),stream=await events();t.after(()=>stream.close());await stream.next('overview');
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    await post('heartbeat',{connectionId:stream.connectionId});
    t.mock.timers.tick(45000);
    assert.equal(remote.stream,null);assert.equal(remote.view().phoneConnected,false);
  }finally{t.mock.timers.reset();}
});

test('simultaneous scans claim a QR once and persist the same winning device',async t=>{
  const {remote,post}=await setup(t),code=await remote.qr('127.0.0.1','simultaneous-qr');
  const key=new URLSearchParams(new URL(code.url).hash.slice(1)).get('k');
  const results=await Promise.all(['device-first-scan','device-second-scan'].map(as=>post('hello',{},{secret:key,as})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(JSON.parse(await fs.readFile(remote.file,'utf8')).device,remote.pairing.device);
  assert.equal(remote.pairing.secret,key);
  assert(!JSON.stringify(remote.view()).includes(key),'the grant never enters broadcast state');
});

test('reset and QR retrieval wait for a claim being saved, so an old request cannot restore a revoked key',async t=>{
  const {remote,post}=await setup(t);await post('hello');
  const code=await remote.qr('127.0.0.1','claim-before-reset'),oldVersion=remote.view().pairingVersion;
  const key=new URLSearchParams(new URL(code.url).hash.slice(1)).get('k');
  let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),save=remote.savePairing.bind(remote);let first=true;
  remote.savePairing=async value=>{if(first){first=false;entered();await gate;}return save(value);};
  const claiming=post('hello',{},{secret:key,as:'device-claiming'});await began;
  const resetting=remote.resetPairing(),nextQr=remote.qr('127.0.0.1','qr-after-reset');release();
  assert.equal((await claiming).status,200);await resetting;
  const fresh=await nextQr;
  assert.notEqual(fresh.pairingVersion,oldVersion);
  assert.equal(fresh.pairingVersion,remote.view().pairingVersion);
  const saved=JSON.parse(await fs.readFile(remote.file,'utf8'));
  assert.equal(saved.secret,remote.pairing.secret);assert.equal(saved.device,null);
  assert.equal((await post('hello',{},{secret:key,as:'device-claiming'})).status,403);
  await assert.rejects(remote.qr('127.0.0.1','stale-qr-request',oldVersion),{code:'PHONE_QR_CHANGED'});
  const newKey=new URLSearchParams(new URL(fresh.url).hash.slice(1)).get('k');
  assert.equal((await post('hello',{},{secret:newKey,as:'device-after-reset'})).status,200);
});

test('a tab closing clears presence promptly while its already submitted model turn continues',async t=>{
  const {remote,events,post,gateway}=await setup(t),stream=await events();await stream.next('overview');
  await post('send',{threadId:'t-idle',text:'Keep running'});assert.equal(remote.phoneTurns.size,1);
  stream.close();
  for(let i=0;i<100&&remote.view().phoneConnected;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(remote.view().phoneConnected,false);assert.equal(remote.phoneTurns.size,1);
  assert(!gateway.seen.some(m=>m.method==='turn/interrupt'),'closing the tab never replays or cancels submitted work');
});

test('an SSE request authenticated just before reset cannot reopen a revoked stream afterwards',async t=>{
  const {remote,events}=await setup(t);let entered,release;
  const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),verify=remote.verify.bind(remote);
  remote.verify=async(...args)=>{const result=await verify(...args);entered();await gate;return result;};
  const connecting=events();await began;await remote.resetPairing();release();
  const stream=await connecting;t.after(()=>stream.close());
  assert.equal(stream.status,403);assert.equal(remote.stream,null);assert.equal(remote.view().phoneConnected,false);
});

test('stopping and starting the same server does not make a used signed request replayable',async t=>{
  const {remote,post}=await setup(t),time=Date.now(),nonce='nonce-across-stop';
  assert.equal((await post('hello',{},{time,nonce})).status,200);
  await remote.stop();await remote.start();
  assert.equal((await post('hello',{},{time,nonce})).status,401);
});
test('a phone whose browser lost its id re-pairs by scanning the code on screen, once per showing',async t=>{
  const {remote,post}=await setup(t);
  const keyOf=code=>new URLSearchParams(new URL(code.url).hash.slice(1)).get('k');
  const first=keyOf(await remote.qr('127.0.0.1'));
  assert.equal((await post('hello',{},{secret:first})).status,200);
  assert.equal(remote.view().claimOpen,false,'pairing uses up the shown code');
  // The tab was closed in a browser that keeps no data: same code, new id.
  assert.equal((await post('hello',{},{as:'device-cccccccc'})).status,409,'no code on screen: refused');
  assert.equal(remote.pairing.device,'device-aaaaaaaa');
  const fresh=keyOf(await remote.qr('127.0.0.1'));assert.equal(remote.view().claimOpen,true);
  assert.equal((await post('hello',{},{secret:fresh,as:'device-cccccccc'})).status,200,'scanning the shown code takes over');
  assert.equal(remote.pairing.device,'device-cccccccc');
  assert.equal(JSON.parse(await fs.readFile(remote.file,'utf8')).device,'device-cccccccc');
  assert.equal((await post('hello',{},{as:'device-aaaaaaaa'})).status,409,'the old id cannot take it back without a new showing');
  const expired=keyOf(await remote.qr('127.0.0.1'));remote.now=()=>Date.now()+11*60*1000;
  assert.equal((await post('hello',{},{secret:expired,as:'device-dddddddd',time:Date.now()+11*60*1000})).status,410,'an expired QR is distinguished from a changed key');
});
test('the phone can call only the fixed command list, never raw Codex methods',async t=>{
  const {post,gateway}=await setup(t);
  for(const cmd of ['thread/list','fs/writeFile','command/exec','config/write','constructor','__proto__']){
    const r=await post(cmd,{path:'C:\\x'});assert.equal(r.body.ok,false,cmd);assert.equal(r.body.code,'PHONE_COMMAND');
  }
  assert(!gateway.seen.some(m=>['fs/writeFile','command/exec','config/write'].includes(m.method)));
});
test('overview carries quota but not account e-mail; switching uses the main-process action',async t=>{
  const {post,selected}=await setup(t);
  const r=await post('overview');assert.equal(r.body.result.accounts[0].limits[0].windows[0].usedPercent,30);
  assert(!JSON.stringify(r.body.result).includes('private@example.com'));
  assert.equal((await post('useAccount',{id:'p1'})).body.ok,true);assert.deepEqual(selected,['p1']);
  assert.equal((await post('useAccount',{id:'nope'})).body.ok,false);
});
test('sessions are listed, read and continued through the gateway; a busy session is not prompted',async t=>{
  const {post,gateway}=await setup(t);
  const list=await post('threads');assert.deepEqual(list.body.result.threads.map(x=>x.id),['t-idle','claude:11111111-1111-4111-8111-111111111111','t-busy','t-gone'],'both providers, newest first');
  assert.deepEqual((await post('threads',{provider:'codex'})).body.result.threads.map(x=>x.provider),['codex','codex','codex']);
  const read=await post('thread',{threadId:'t-idle'});
  assert.deepEqual(read.body.result.turns[0].items.map(i=>[i.type,i.text]),[['user','hi'],['agent','Hello!']]);
  assert(gateway.seen.some(m=>m.method==='thread/resume'&&m.params.threadId==='t-idle'),'the phone subscribes for live events');
  const init=gateway.seen.find(m=>m.method==='initialize');assert.equal(init.params.clientInfo.name,'padswitcher_phone');
  const sent=await post('send',{threadId:'t-idle',text:'tiếp tục'});assert.equal(sent.body.ok,true);
  const start=gateway.seen.find(m=>m.method==='turn/start');assert.deepEqual(start.params,{threadId:'t-idle',input:[{type:'text',text:'tiếp tục'}]});
  const busy=await post('send',{threadId:'t-busy',text:'x'});assert.equal(busy.body.code,'PHONE_THREAD_ACTIVE');
  assert.equal((await post('send',{threadId:'t-idle',text:'   '})).body.code,'PHONE_PROMPT');
  assert.equal((await post('thread',{threadId:'../etc'})).body.code,'PHONE_THREAD');
  const stop=await post('interrupt',{threadId:'t-busy'});assert.equal(stop.body.result.turnId,'turn-9');
});
test('new sessions start only in folders that already have a session, using the recorded path',async t=>{
  const {post,gateway}=await setup(t);
  const folders=(await post('folders')).body.result.folders.map(f=>f.path).sort();assert.deepEqual(folders,['C:\\Work\\App','D:\\Data'],'a deleted folder is not offered');
  assert.equal((await post('newThread',{cwd:'D:\\Gone',text:'x'})).body.code,'PHONE_FOLDER');
  const denied=await post('newThread',{cwd:'C:\\Windows',text:'x'});assert.equal(denied.body.code,'PHONE_FOLDER');
  assert(!gateway.seen.some(m=>m.method==='thread/start'));
  const ok=await post('newThread',{cwd:'c:\\work\\app\\',text:'Viết test'});assert.equal(ok.body.ok,true);assert.equal(ok.body.result.threadId,'t-new');
  const start=gateway.seen.find(m=>m.method==='thread/start');assert.deepEqual(start.params,{cwd:'C:\\Work\\App'});
});
test('a phone turn keeps the approval and sandbox mode the session last ran with on the computer',async t=>{
  const {post,gateway}=await setup(t);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pad-rollout-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const rollout=async(name,...contexts)=>{const file=path.join(dir,name);
    await fs.writeFile(file,[{type:'session_meta',payload:{}},...contexts.map(c=>({type:'turn_context',payload:c})),{type:'response_item',payload:{text:'"turn_context"'}}].map(l=>JSON.stringify(l)).join('\n')+'\n');return file;};
  gateway.threads.get('t-idle').path=await rollout('idle.jsonl',{approval_policy:'on-request',sandbox_policy:{type:'read-only'}},{approval_policy:'never',sandbox_policy:{type:'danger-full-access'}});
  gateway.threads.get('t-busy').path=await rollout('busy.jsonl',{approval_policy:'on-request',sandbox_policy:{type:'workspace-write',network_access:true,exclude_tmpdir_env_var:false,exclude_slash_tmp:false}});
  assert.equal((await post('thread',{threadId:'t-idle'})).body.result.thread.mode,'Toàn quyền');
  assert.equal((await post('send',{threadId:'t-idle',text:'tiếp'})).body.ok,true);
  const start=gateway.seen.find(m=>m.method==='turn/start');
  assert.equal(start.params.approvalPolicy,'never');assert.deepEqual(start.params.sandboxPolicy,{type:'dangerFullAccess'});
  const folders=(await post('folders')).body.result.folders;
  assert(folders.every(f=>!('latest' in f)),'rollout paths stay on the computer');
  assert.equal((await post('newThread',{cwd:'D:\\Data',text:'x'})).body.ok,true);
  const second=gateway.seen.filter(m=>m.method==='turn/start')[1];
  assert.equal(second.params.approvalPolicy,'on-request','a new session takes the mode of the folder\'s latest session');
  assert.deepEqual(second.params.sandboxPolicy,{type:'workspaceWrite',writableRoots:[],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false});
});
test('approvals reach the phone over SSE, accept only known decisions and are answered once',async t=>{
  const {post,events,gateway,remote}=await setup(t);
  await post('thread',{threadId:'t-idle'});
  const stream=await events();t.after(()=>stream.close());assert.equal(stream.status,200);
  assert.equal((await stream.next('overview')).accounts.length,1);
  gateway.send({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'t-idle',turnId:'turn-1',itemId:'c1',command:'npm test',cwd:'C:\\Work\\App',kind:'command',startedAtMs:1,environmentId:null}});
  const approval=await stream.next('approval');assert.equal(approval.command,'npm test');assert.equal(approval.answerable,true);
  assert.equal((await post('approve',{id:approval.id,decision:'yolo'})).body.code,'PHONE_APPROVAL_INVALID');
  const answered=new Promise(r=>gateway.socket.once('message',d=>r(JSON.parse(d))));
  assert.equal((await post('approve',{id:approval.id,decision:'accept'})).body.ok,true);
  assert.deepEqual(await answered,{id:77,result:{decision:'accept'}});
  assert.equal((await post('approve',{id:approval.id,decision:'accept'})).body.code,'PHONE_APPROVAL_GONE');
  // Requests the phone cannot answer are left for the desktop client.
  gateway.send({id:78,method:'item/tool/requestUserInput',params:{threadId:'t-idle'}});
  const other=await stream.next('approval');assert.equal(other.answerable,false);
  assert.equal((await post('approve',{id:other.id,decision:'accept'})).body.code,'PHONE_APPROVAL_INVALID');
  gateway.send({method:'serverRequest/resolved',params:{threadId:'t-idle',requestId:78}});
  assert.equal((await stream.next('approvalResolved')).id,'77','the phone answer is announced');assert.equal((await stream.next('approvalResolved')).id,'78');assert.equal(remote.bridge.requests.size,0);
});
test('live Codex events are forwarded in reduced form and stopping waits for a phone turn',async t=>{
  const {post,events,gateway,remote}=await setup(t);
  const stream=await events();t.after(()=>stream.close());
  await post('send',{threadId:'t-idle',text:'go'});assert.equal(remote.phoneTurns.size,1);
  await assert.rejects(remote.stop(),{code:'PHONE_ACTIVE_TURN'});
  gateway.send({method:'item/completed',params:{threadId:'t-idle',turnId:'turn-new',item:{type:'commandExecution',id:'c2',command:'dir',cwd:'C:\\',status:'completed',exitCode:0,aggregatedOutput:'x'.repeat(5000),commandActions:[]}}});
  const item=(await stream.next('live'));assert.equal(item.item.type,'command');assert(item.item.output.length<=2001);
  gateway.send({method:'turn/completed',params:{threadId:'t-idle',turn:{id:'turn-new',status:'completed',items:[]}}});
  assert.equal((await stream.next('live')).method,'turn/completed');
  assert.equal(remote.phoneTurns.size,0);
  await remote.stop();assert.equal(remote.status,'stopped');
});
test('the phone page and fonts are served with a strict CSP; other paths are not',async t=>{
  const {base}=await setup(t);
  const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  assert.match(await page.text(),/PADSwitcher/);
  assert.equal((await fetch(base+'/fonts/BeVietnamPro-Regular.ttf')).status,200);
  for(const p of ['/fonts/../../main.cjs','/phone-server.cjs','/static/phone.js','/api/call'])assert.equal((await fetch(base+p)).status,404,p);
});
test('Claude commands route to the Claude bridge, and Kaggle quota and finished notebooks reach the phone',async t=>{
  const {post,events,claude,service,remote}=await setup(t);
  const id='claude:11111111-1111-4111-8111-111111111111';
  await post('thread',{threadId:id});await post('send',{threadId:id,text:'tiếp',fork:true});
  await post('newThread',{provider:'claude',cwd:'C:\Claude',text:'mới'});await post('interrupt',{threadId:id});
  await post('approve',{id:'claude-1',decision:'accept'});
  assert.deepEqual(claude.calls.map(c=>c[0]),['read','send','new','interrupt','answer']);
  assert.equal(claude.calls[1][1].fork,true);assert.equal((await post('send',{threadId:id,text:'  '})).body.code,'PHONE_PROMPT');
  assert.deepEqual((await post('folders',{provider:'claude'})).body.result.folders.map(f=>f.path),['C:\Claude']);
  let notebooks=[{ref:'me/train',title:'Train',status:'running',accelerator:'GPU',lastRunAt:'2026-11-22T09:20:33'}];
  service.kaggle={refreshAll:async()=>{},view:()=>({accounts:[{id:'k1',username:'me',label:'Kaggle chính',status:'ready',watch:['me/train'],quota:[{resource:'GPU',used:10.3,remaining:19.7,total:30,refreshAt:'2026-11-28T00:00:00'}],notebooks}]})};
  const over=(await post('overview')).body.result;
  assert.equal(over.kaggle.accounts[0].quota[0].remaining,19.7);assert.equal(over.kaggle.accounts[0].notebooks[0].watched,true);
  assert.equal(over.claude.usage,null);assert.equal((await post('kaggleRefresh')).body.ok,true);
  const stream=await events();t.after(()=>stream.close());await stream.next('overview');
  service.changed();// first look records the running notebook without announcing it
  notebooks=[{...notebooks[0],status:'complete'}];service.changed();
  assert.deepEqual(await stream.next('kaggle'),{ref:'me/train',title:'Train',status:'complete',account:'Kaggle chính'});
  // a Claude turn from the phone blocks turning the connection off, like a Codex one
  claude.runs.set('x',{});await assert.rejects(remote.stop(),{code:'PHONE_ACTIVE_TURN'});claude.runs.clear();
});
test('a session opens on the computer only through the extensions\' own links or Claude Code in a terminal',async t=>{
  const {post,opened,terminals,claude}=await setup(t);
  const id='11111111-1111-4111-8111-111111111111',phoneMade='22222222-2222-4222-8222-222222222222';
  assert.equal((await post('openOnComputer',{threadId:'claude:'+id})).body.result.opened,'vscode');
  assert.equal((await post('openOnComputer',{threadId:'t-idle'})).body.result.opened,'vscode');
  assert.deepEqual(opened,['vscode://anthropic.claude-code/open?session='+id,'vscode://openai.chatgpt/local/t-idle']);
  claude.hidden.add(phoneMade);
  assert.equal((await post('openOnComputer',{threadId:'claude:'+phoneMade})).body.result.opened,'terminal','VS Code hides a session the phone started');
  assert.deepEqual(terminals,[{file:'C:\\claude.exe',cwd:'C:\\Work',sessionId:phoneMade}]);
  for(const threadId of ['claude:../x','t-idle?x=1','https://evil.example','claude:'+id+'&prompt=rm'])
    assert.equal((await post('openOnComputer',{threadId})).body.ok,false,threadId);
  claude.runs.set(id,{});
  assert.equal((await post('openOnComputer',{threadId:'claude:'+id})).body.code,'PHONE_THREAD_ACTIVE','two Claude Code processes never write one session');
  assert.equal(opened.length,2);
});
