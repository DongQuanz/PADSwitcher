'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{WebSocketServer}=require('ws');
const windows=require('../src/core/windows.cjs');
const {CodexRpc}=require('../src/core/rpc.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('native desktop startup forwards the actual network policy without opening inference or signing out',{timeout:20000},async t=>{
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'startup-')),helper=path.join(root,'PADCodex.exe');await fs.copyFile(path.resolve('src/assets/PADCodex.exe'),helper);
  const token=crypto.randomBytes(32).toString('hex'),server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  t.after(async()=>{for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));assert.equal(path.dirname(path.resolve(root)).toLowerCase(),parent.toLowerCase());await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(root,'client-capability'),token);await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({version:1,url:'ws://127.0.0.1:'+server.address().port,tokenFile:path.join(root,'client-capability')}));
  const policy={requirements:{application:{network:{enabled:true,domains:{'example.test':'allow','blocked.test':'deny'}}}}},seen=[];let fail=false;
  server.on('connection',(socket,request)=>{assert.equal(request.headers.authorization,'Bearer '+token);socket.on('message',data=>{const m=JSON.parse(data);seen.push(m);if(m.id==null)return;const result=m.method==='initialize'?{userAgent:'codex_desktop/0.165.0-alpha.1.2 (Windows)'}:policy;socket.send(JSON.stringify(fail&&m.method==='configRequirements/read'?{id:m.id,error:{code:-1,message:'Policy unavailable'}}:{id:m.id,result}));});});
  const run=extra=>new Promise((resolve,reject)=>{const env={...process.env};delete env.PADSWITCHER_CONNECTION_FILE;const child=spawn(helper,['-c','features.code_mode_host=true','app-server','--analytics-default-enabled','--print-startup-config','--startup-client-info','{"name":"codex_desktop","version":"fixture"}',...extra],{env,windowsHide:true,stdio:['ignore','pipe','ignore']});let text='';child.stdout.on('data',b=>text+=b);child.on('error',reject);child.on('close',code=>resolve({code,value:JSON.parse(text)}));});
  const success=await run([]);assert.equal(success.code,0);assert.equal(success.value.appServerVersion,'0.165.0-alpha.1.2');assert.deepEqual(success.value.configRequirements,policy);
  assert.equal(seen[0].params._padswitcherStartup,true);assert.equal(seen[0].params.clientInfo.name,'codex_desktop');assert.equal(seen[0].params.clientInfo.version,'fixture');assert.deepEqual(seen.map(m=>m.method),['initialize','initialized','configRequirements/read']);
  fail=true;const failed=await run([]);assert.equal(failed.code,1);assert.equal(failed.value.error.code,-32000);assert.equal(failed.value.configRequirements,undefined);
  const before=seen.length,signOut=await run(['--startup-sign-out']);assert.equal(signOut.code,1);assert.equal(signOut.value.error.code,-32000);assert.equal(seen.length,before);
});
test('native desktop handshake carries only allowed startup configuration and uses the adjacent gateway',{timeout:20000},async t=>{
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'helper-')),helper=path.join(root,'PADCodex.exe');await fs.copyFile(path.resolve('src/assets/PADCodex.exe'),helper);
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  let child,received;const token=crypto.randomBytes(32).toString('hex');
  t.after(async()=>{child?.kill();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(root,'client-capability'),token);await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({version:1,url:'ws://127.0.0.1:'+server.address().port,tokenFile:path.join(root,'client-capability')}));
  const initialized=new Promise(resolve=>server.on('connection',(socket,request)=>{assert.equal(request.headers.authorization,'Bearer '+token);socket.on('message',bytes=>{const m=JSON.parse(bytes);if(m.method==='initialize'){received=m;socket.send(JSON.stringify({id:m.id,result:{}}));resolve();}});}));
  const env={...process.env,PADSWITCHER_CLIENT_KIND:'desktop',CODEX_APP_TOOLS_PIPE_PATH:'\\\\.\\pipe\\fixture-current',CODEX_MCP_NODE_PATH:process.execPath};delete env.PADSWITCHER_CONNECTION_FILE;
  child=spawn(helper,['app-server','-c','plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true','--config=plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=false','-c','model_provider="private-unrelated"'],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'Codex Desktop'}}})+'\n');await initialized;
  assert.equal(received.params._padswitcherClient,'desktop');assert.deepEqual(received.params._padswitcherDesktopEnvironment,{CODEX_APP_TOOLS_PIPE_PATH:env.CODEX_APP_TOOLS_PIPE_PATH,CODEX_MCP_NODE_PATH:process.execPath});
  assert.deepEqual(received.params._padswitcherDesktopConfig,{'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled':true,'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled':false});
});
test('native stdio host owns its Codex process and closes it when the manager dies',{timeout:25000},async t=>{
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'owner-')),exe=await windows.findGatewayCodex();
  const script="const {CodexRpc}=require('./src/core/rpc.cjs');const r=new CodexRpc(process.argv[1],process.argv[2],{isolated:true,ephemeralStore:true});r.initialize().then(()=>{console.log(r.child.pid);setInterval(()=>{},1000);}).catch(()=>process.exit(1));";
  const owner=spawn(process.execPath,['-e',script,exe,root],{cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','ignore'],windowsHide:true});
  t.after(async()=>{owner.kill();await pause(300);await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const hostPid=await new Promise((resolve,reject)=>{let text='';owner.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(Number(text.trim()));});owner.once('exit',()=>reject(Error('Owner exited before native initialization')));});
  assert(Number.isSafeInteger(hostPid));const list=await windows.processes(),native=list.find(p=>p.ParentProcessId===hostPid&&p.Name.toLowerCase()==='codex.exe');assert(native);
  owner.kill();let alive;for(let i=0;i<20;i++){alive=(await windows.processes()).some(p=>p.ProcessId===native.ProcessId||p.ProcessId===hostPid);if(!alive)break;await pause(100);}assert.equal(alive,false);
});

test('native helper opens the manager once for a waiting client, with a clean environment, then connects',{timeout:40000},async t=>{
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'launch-')),helper=path.join(root,'PADCodex.exe'),source=path.join(root,'Manager.cs'),manager=path.join(root,'Fixture Manager.exe'),marker=path.join(root,'started.txt');
  await fs.copyFile(path.resolve('src/assets/PADCodex.exe'),helper);
  await fs.writeFile(source,'using System;using System.IO;class P{static void Main(string[] a){File.AppendAllText(Environment.GetEnvironmentVariable("FIXTURE_MARKER"),String.Join(",",a)+"|"+Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")+"|"+Environment.GetEnvironmentVariable("CODEX_HOME")+"\\n");}}');
  const compiled=spawn(path.join(process.env.SystemRoot||process.env.SYSTEMROOT,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/out:'+manager,source],{windowsHide:true,stdio:'ignore'});
  assert.equal(await new Promise(r=>compiled.once('close',r)),0);
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  let child;t.after(async()=>{child?.kill();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));await pause(200);await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await fs.writeFile(path.join(root,'launcher.json'),JSON.stringify({version:1,executable:manager}));
  const token=crypto.randomBytes(32).toString('hex'),received=new Promise(resolve=>server.on('connection',socket=>socket.on('message',bytes=>resolve(JSON.parse(bytes)))));
  const env={...process.env,FIXTURE_MARKER:marker,ELECTRON_RUN_AS_NODE:'1',CODEX_HOME:'inherited-home'};delete env.PADSWITCHER_CONNECTION_FILE;
  child=spawn(helper,['app-server'],{env,stdio:['pipe','pipe','ignore'],windowsHide:true});child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'codex_vscode'}}})+'\n');
  let started='';for(let i=0;i<100&&!started;i++){started=await fs.readFile(marker,'utf8').catch(()=>'');if(!started)await pause(100);}
  assert.equal(started.trim(),'--background||');
  await pause(1500);await fs.writeFile(path.join(root,'client-capability'),token);await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({version:1,url:'ws://127.0.0.1:'+server.address().port,tokenFile:path.join(root,'client-capability')}));
  assert.equal((await received).method,'initialize','the first client message waited in stdin');assert.equal((await fs.readFile(marker,'utf8')).trim().split('\n').length,1);
});
test('without a launcher, a stopped connection still fails at once',{timeout:15000},async t=>{
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'stopped-')),helper=path.join(root,'PADCodex.exe');await fs.copyFile(path.resolve('src/assets/PADCodex.exe'),helper);
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env};delete env.PADSWITCHER_CONNECTION_FILE;const began=Date.now(),child=spawn(helper,['app-server'],{env,stdio:'ignore',windowsHide:true});
  assert.equal(await new Promise(r=>child.once('close',r)),1);assert(Date.now()-began<3000);
});

async function standaloneFixture(t){
  const parent=path.resolve('artifacts/tests');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'standalone-')),helper=path.join(root,'PADCodex.exe'),home=path.join(root,'original-home');
  await fs.mkdir(home);await fs.copyFile(path.resolve('src/assets/PADCodex.exe'),helper);
  await fs.writeFile(path.join(root,'standalone.json'),JSON.stringify({version:1,executable:await windows.findGatewayCodex()}));
  const children=[];
  const track=child=>{children.push(child);return child;};
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await Promise.race([closed,pause(3000)]);}
    await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  const environment={...process.env,CODEX_HOME:home};
  for(const name of Object.keys(environment)){
    const upper=name.toUpperCase();
    if(upper.startsWith('PADSWITCHER_')||(upper.startsWith('CODEX_')&&upper!=='CODEX_HOME')||/^(?:OPENAI_API_KEY|ACCESS_TOKEN|OPENAI_BASE_URL|OPENAI_IDENTITY_TOKEN_FILE|OPENAI_WORKSPACE_ID|OPENAI_FEDERATION_RULE_ID|OPENAI_WORKLOAD_IDENTITY_CONTEXT|BROWSER_USE_ACCESS_VERIFYING_IDENTITY|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(name))delete environment[name];
  }
  return {root,helper,home,environment,track};
}

test('after a stopped gateway the VS Code helper runs native Codex with the original login and home',{timeout:30000},async t=>{
  const {root,helper,home,environment,track}=await standaloneFixture(t);
  // A fake API-key login exercises native credential loading without ChatGPT policy discovery.
  const original=JSON.stringify({OPENAI_API_KEY:'fixture-only-native-key'}),config='cli_auth_credentials_store = "file"\nopenai_base_url = "http://127.0.0.1:9/"\n';
  await fs.writeFile(path.join(home,'auth.json'),original);await fs.writeFile(path.join(home,'config.toml'),config);
  const rpc=new CodexRpc(helper,home,{isolated:true,fileStore:true,spawn:(exe,args,options)=>track(spawn(exe,args,{...options,env:environment}))});
  t.after(()=>rpc.close());
  const initialized=await rpc.request('initialize',{clientInfo:{name:'codex_vscode',version:'fixture'}});
  assert.equal(path.resolve(initialized.codexHome).toLowerCase(),home.toLowerCase());rpc.send({method:'initialized',params:{}});
  assert.equal((await rpc.request('account/read',{refreshToken:false})).account.type,'apiKey');
  await rpc.close();
  assert.equal(await fs.readFile(path.join(home,'auth.json'),'utf8'),original);
  assert.equal(await fs.readFile(path.join(home,'config.toml'),'utf8'),config);
  await assert.rejects(fs.access(path.join(root,'connection.json')),{code:'ENOENT'});
});

test('native fallback is forbidden for explicit connections, desktop, ACP and retained gateway descriptors',{timeout:20000},async t=>{
  const {root,helper,environment,track}=await standaloneFixture(t);
  const run=env=>new Promise((resolve,reject)=>{const child=track(spawn(helper,['app-server'],{env,stdio:'ignore',windowsHide:true}));child.once('error',reject);child.once('close',resolve);});
  for(const kind of ['desktop','jetbrains'])assert.equal(await run({...environment,PADSWITCHER_CLIENT_KIND:kind}),1,kind);
  assert.equal(await run({...environment,PADSWITCHER_CONNECTION_FILE:path.join(root,'connection.json')}),1,'an explicitly selected gateway stays explicit');
  await fs.writeFile(path.join(root,'connection.json'),'{}');
  assert.equal(await run(environment),1,'a corrupt or retained managed connection must not select another account');
});

test('a connected VS Code helper never falls back or replays stdin after the managed connection closes',{timeout:20000},async t=>{
  const {root,helper,environment,track}=await standaloneFixture(t),token=crypto.randomBytes(32).toString('hex');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  let child;t.after(async()=>{child?.kill();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));});
  await fs.writeFile(path.join(root,'client-capability'),token);
  await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({version:1,url:'ws://127.0.0.1:'+server.address().port,tokenFile:path.join(root,'client-capability')}));
  const received=new Promise(resolve=>server.once('connection',socket=>socket.once('message',data=>resolve({socket,message:JSON.parse(data)}))));
  child=track(spawn(helper,['app-server'],{env:environment,stdio:['pipe','pipe','ignore'],windowsHide:true}));child.stdin.on('error',()=>{});
  const closed=new Promise(resolve=>child.once('close',resolve));
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'codex_vscode'}}})+'\n');
  const {socket,message}=await received;assert.equal(message.method,'initialize');
  await fs.unlink(path.join(root,'connection.json'));socket.close();
  assert.equal(await closed,0,'a later close ends the existing bridge; a new native process would keep waiting on stdin');
});
