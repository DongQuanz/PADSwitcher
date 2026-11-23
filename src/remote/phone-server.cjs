'use strict';
// Phone remote over the local network: the QR code
// carries a secret, one phone is bound to it, and "new code" revokes that phone.
// Differences: the secret never travels after the scan (every request is HMAC-signed
// with a timestamp and nonce), only private-network peers are served, and the phone
// can call a fixed list of commands instead of raw Codex JSON-RPC.
const {EventEmitter}=require('node:events');
const http=require('node:http');
const net=require('node:net');
const os=require('node:os');
const dgram=require('node:dgram');
const path=require('node:path');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const {atomicWrite,assertDirectory}=require('../core/files.cjs');
const {UserError,publicError}=require('../core/errors.cjs');
const {CodexBridge}=require('./codex-bridge.cjs');
const {ClaudeBridge,isClaude}=require('./claude-bridge.cjs');
const {ClaudeUsage}=require('./claude-usage.cjs');
const qr=require('./qr.cjs');
const {simplifyItem,simplifyTurn,simplifyThread,simplifyRequest}=require('./present.cjs');
const {codexMode,codexTurnParams}=require('./modes.cjs');

const DEFAULT_PORT=47860;
const MAX_BODY=64*1024;
const MAX_PROMPT=20000;
const CLOCK_SKEW=5*60*1000;
const IDLE_STOP=30*60*1000;
// How long a QR code shown on the computer may move control to a phone the computer does not know.
const CLAIM_WINDOW=10*60*1000;
const STATIC_DIR=path.join(__dirname,'static');
const FONT_DIR=path.join(__dirname,'..','assets','fonts');
const STATIC={
  '/':['phone.html','text/html; charset=utf-8'],
  '/phone.js':['phone.js','text/javascript; charset=utf-8'],
  '/phone.css':['phone.css','text/css; charset=utf-8'],
  '/sha256.js':['sha256.js','text/javascript; charset=utf-8'],
};
const FONTS=new Set(['BeVietnamPro-Regular.ttf','BeVietnamPro-Medium.ttf','BeVietnamPro-SemiBold.ttf']);
const SECURITY_HEADERS={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const ID=/^[A-Za-z0-9_-]{8,64}$/;
const THREAD_ID=/^[A-Za-z0-9_-]{1,100}$/;
// Links registered by the Claude Code and Codex VS Code extensions to open one session.
const PHONE_LINK=/^vscode:\/\/(anthropic\.claude-code\/open\?session=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|openai\.chatgpt\/local\/[A-Za-z0-9_-]{1,100})$/i;

function privateAddress(address){
  const a=String(address||'').replace(/^::ffff:/i,'');
  if(net.isIPv4(a)){const [x,y]=a.split('.').map(Number);return x===10||x===127||(x===172&&y>=16&&y<=31)||(x===192&&y===168);}
  if(net.isIPv6(a))return a==='::1'||/^f[cd]/i.test(a)||/^fe[89ab]/i.test(a);
  return false;
}
// The address of the default route first (what the phone on the same Wi-Fi reaches),
// then other private IPv4 addresses; virtual adapters (WSL, Hyper-V) usually sort last.
async function lanAddresses(){
  const found=[];
  const primary=await new Promise(resolve=>{
    const socket=dgram.createSocket('udp4');const done=v=>{try{socket.close();}catch{}resolve(v);};
    socket.on('error',()=>done(null));
    try{socket.connect(1,'10.255.255.255',()=>{try{done(socket.address().address);}catch{done(null);}});}catch{done(null);}
  });
  if(primary&&privateAddress(primary)&&!primary.startsWith('127.'))found.push(primary);
  const rank=a=>a.startsWith('192.168.')?0:a.startsWith('10.')?1:2;
  const others=Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal&&privateAddress(i.address)).map(i=>i.address).sort((a,b)=>rank(a)-rank(b));
  for(const a of others)if(!found.includes(a))found.push(a);
  return found;
}
const sign=(secret,message)=>crypto.createHmac('sha256',Buffer.from(secret,'utf8')).update(message,'utf8').digest('hex');
function safeEqual(a,b){const x=Buffer.from(String(a||''),'utf8'),y=Buffer.from(String(b||''),'utf8');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
const samePath=(a,b)=>path.win32.normalize(String(a)).replace(/[\\/]+$/,'').toLowerCase()===path.win32.normalize(String(b)).replace(/[\\/]+$/,'').toLowerCase();

class PhoneRemote extends EventEmitter{
  constructor({root,service,gateway,actions={},version='0',port=DEFAULT_PORT,now=()=>Date.now(),addresses=lanAddresses,folderExists=null,claude=null,claudeUsage=null}){
    super();this.options={folderExists};
    this.root=path.join(root,'phone');this.file=path.join(this.root,'pairing.json');
    this.service=service;this.gateway=gateway;this.actions=actions;this.version=version;this.preferredPort=port;this.now=now;this.addresses=addresses;
    this.status='stopped';this.error=null;this.server=null;this.port=null;this.ips=[];this.pairing=null;
    this.stream=null;this.lastSeen=0;this.claimUntil=0;this.nonces=new Map();this.failures=new Map();this.folderCache=null;this.phoneTurns=new Set();
    this.bridge=new CodexBridge(gateway,{version});
    this.bridge.on('notification',(m,p)=>this.forward(m,p));
    this.bridge.on('request',r=>this.push('approval',simplifyRequest(r)));
    this.bridge.on('resolved',id=>this.push('approvalResolved',{id}));
    this.bridge.on('closed',()=>{this.phoneTurns.clear();this.push('live',{method:'bridge/closed'});});
    this.claude=claude||new ClaudeBridge({folderExists:folderExists||undefined});
    this.claudeUsage=claudeUsage||new ClaudeUsage({root});
    this.claude.on('live',e=>this.push('live',e));
    this.claude.on('request',r=>this.push('approval',r));
    this.claude.on('resolved',id=>this.push('approvalResolved',{id}));
    this.claude.on('rateLimit',info=>{this.claudeUsage.fromEvent(info);this.scheduleOverview();});
    this.claude.on('changed',()=>this.changed());
    this.claudeUsage.status().then(()=>this.changed(),()=>{});
    this.kaggleStates=new Map();
    this.onChange=()=>{this.watchKaggle();this.scheduleOverview();};
  }
  view(){return {status:this.status,port:this.port,ips:[...this.ips],paired:!!this.pairing?.device,phoneConnected:!!this.stream,claimOpen:this.now()<this.claimUntil,lastSeen:this.lastSeen?new Date(this.lastSeen).toISOString():null,activeTurns:this.phoneTurns.size+this.claude.active,claudeStatusLine:this.claudeUsage.setup,error:this.error};}
  changed(){this.emit('change');this.service?.changed?.();}
  async loadPairing(){
    await fs.mkdir(this.root,{recursive:true});await assertDirectory(this.root);
    await this.service?.platform?.protectDirectory?.(this.root);
    try{
      const data=JSON.parse(await fs.readFile(this.file,'utf8'));
      if(data?.version===1&&typeof data.secret==='string'&&data.secret.length>=32&&(data.device===null||ID.test(data.device)))return this.pairing={version:1,secret:data.secret,device:data.device,port:Number.isInteger(data.port)?data.port:null};
    }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    return this.pairing={version:1,secret:crypto.randomBytes(32).toString('base64url'),device:null,port:null};
  }
  async savePairing(){await atomicWrite(this.file,JSON.stringify(this.pairing));}
  async start(){
    if(['ready','starting'].includes(this.status))return this.view();
    this.status='starting';this.error=null;this.changed();
    try{
      await this.loadPairing();
      this.ips=await this.addresses();
      if(!this.ips.length)throw new UserError('Máy tính chưa kết nối mạng nội bộ (Wi-Fi/LAN). Kết nối Wi-Fi rồi bật lại.','PHONE_NO_NETWORK');
      const server=http.createServer((req,res)=>this.handle(req,res).catch(()=>{try{this.reply(res,500,{error:'Lỗi máy chủ.'});}catch{}}));
      server.headersTimeout=15000;server.requestTimeout=0;server.keepAliveTimeout=5000;
      const first=this.pairing.port||this.preferredPort;let bound=null;
      for(const port of [first,...Array.from({length:10},(_,i)=>this.preferredPort+i).filter(p=>p!==first)]){
        try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.off('error',reject);resolve();});});bound=server.address().port;break;}
        catch(e){if(e.code!=='EADDRINUSE'&&e.code!=='EACCES')throw e;}
      }
      if(!bound)throw new UserError('Không mở được cổng cho điện thoại. Đóng chương trình đang dùng cổng 47860–47869 rồi thử lại.','PHONE_PORT');
      this.server=server;this.port=bound;
      if(this.pairing.port!==bound){this.pairing.port=bound;}
      await this.savePairing();
      this.lastSeen=this.now();
      this.tick=setInterval(()=>this.idle(),30000);this.tick.unref?.();
      this.service?.on?.('change',this.onChange);
      this.status='ready';this.changed();
      return this.view();
    }catch(error){await this.closeServer();this.status='error';this.error=publicError(error).message;this.changed();throw error;}
  }
  idle(){
    if(this.status!=='ready')return;
    // A phone turn is still running: closing would make the gateway interrupt it.
    if(!this.stream&&!this.phoneTurns.size&&!this.claude.active&&this.now()-this.lastSeen>=IDLE_STOP)this.stop().catch(()=>{});
  }
  async closeServer(){
    clearInterval(this.tick);this.tick=null;clearTimeout(this.overviewTimer);this.overviewTimer=null;
    this.service?.off?.('change',this.onChange);
    this.endStream();
    if(this.server){const server=this.server;this.server=null;server.closeAllConnections?.();await new Promise(r=>server.close(()=>r()));}
    this.bridge.close();this.claude.closeAll();this.port=null;this.claimUntil=0;
  }
  async stop(force=false){
    if((this.phoneTurns.size||this.claude.active)&&!force)throw new UserError('Lượt Codex do điện thoại gửi vẫn đang chạy. Chờ hoàn tất hoặc dừng lượt đó trước.','PHONE_ACTIVE_TURN');
    await this.closeServer();this.status='stopped';this.error=null;this.changed();
  }
  async resetPairing(){
    if(!this.pairing)await this.loadPairing();
    this.pairing={...this.pairing,secret:crypto.randomBytes(32).toString('base64url'),device:null};
    await this.savePairing();this.nonces.clear();
    this.push('kicked',{});this.endStream();this.changed();
  }
  phoneUrl(ip){return `http://${ip}:${this.port}/#k=${this.pairing.secret}`;}
  qr(ip){
    if(this.status!=='ready')throw new UserError('Bật kết nối điện thoại trước.','PHONE_STOPPED');
    const address=this.ips.includes(ip)?ip:this.ips[0];const url=this.phoneUrl(address);
    // The code on the computer's screen is the user's consent to (re)pair the phone that scans it.
    this.claimUntil=this.now()+CLAIM_WINDOW;
    return {ip:address,ips:[...this.ips],url,svg:qr.toSvg(qr.encode(url))};
  }
  // ---------- HTTP ----------
  reply(res,code,body,type='application/json; charset=utf-8',extra={}){
    const data=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body),'utf8');
    res.writeHead(code,{...SECURITY_HEADERS,'Content-Type':type,'Content-Length':data.length,...extra});res.end(data);
  }
  blocked(ip){const f=this.failures.get(ip);return !!f&&f.until>this.now();}
  fail(ip){
    const now=this.now(),f=this.failures.get(ip)||{count:0,since:now,until:0};
    if(now-f.since>5*60*1000){f.count=0;f.since=now;}
    if(++f.count>=30)f.until=now+5*60*1000;
    this.failures.set(ip,f);
  }
  async handle(req,res){
    const ip=req.socket.remoteAddress;
    if(!privateAddress(ip)){req.socket.destroy();return;}
    if(this.blocked(ip))return this.reply(res,429,{error:'Quá nhiều lần thử sai. Đợi vài phút rồi quét lại mã QR.'});
    const url=new URL(req.url,'http://phone.invalid');
    if(req.method==='GET'&&Object.hasOwn(STATIC,url.pathname)){
      const [file,type]=STATIC[url.pathname];
      return this.reply(res,200,await fs.readFile(path.join(STATIC_DIR,file)),type);
    }
    if(req.method==='GET'&&url.pathname.startsWith('/fonts/')){
      const name=url.pathname.slice(7);if(!FONTS.has(name))return this.reply(res,404,{error:'Không có trang này.'});
      return this.reply(res,200,await fs.readFile(path.join(FONT_DIR,name)),'font/ttf',{'Cache-Control':'max-age=86400'});
    }
    if(req.method==='GET'&&url.pathname==='/api/events')return this.events(req,res,url,ip);
    if(req.method==='POST'&&url.pathname==='/api/call')return this.call(req,res,ip);
    return this.reply(res,404,{error:'Không có trang này.'});
  }
  // Returns an error [status, message] or null, and binds the first phone.
  async verify(device,time,nonce,signature,message){
    if(!this.pairing||!ID.test(String(device))||!ID.test(String(nonce))||!Number.isFinite(time)||!/^[0-9a-f]{64}$/.test(String(signature)))return [400,'Yêu cầu không hợp lệ.'];
    if(!safeEqual(signature,sign(this.pairing.secret,message)))return [403,'Mã kết nối đã đổi hoặc không đúng. Quét lại mã QR trên PADSwitcher.'];
    const now=this.now();
    if(Math.abs(now-time)>CLOCK_SKEW)return [401,'Giờ trên điện thoại lệch quá nhiều so với máy tính. Bật giờ tự động rồi thử lại.'];
    for(const [n,expires]of this.nonces)if(expires<=now)this.nonces.delete(n);
    if(this.nonces.has(nonce))return [401,'Yêu cầu đã được gửi trước đó.'];
    if(this.nonces.size>=5000)this.nonces.delete(this.nonces.keys().next().value);
    this.nonces.set(nonce,now+2*CLOCK_SKEW);
    if(this.pairing.device!==device){
      // A phone the computer does not know: the first one, or one whose browser erased its id
      // when the tab closed (private tabs, in-app browsers). It takes over only while the QR
      // code is on the computer's screen, once per showing.
      if(this.pairing.device!==null&&this.now()>=this.claimUntil)return [409,'Điện thoại này chưa được ghép nối (trình duyệt có thể đã xoá dữ liệu khi đóng tab). Trên PADSwitcher, bấm “Hiện mã QR” rồi quét lại.'];
      if(this.pairing.device!==null)this.endStream();
      this.pairing.device=device;this.claimUntil=0;await this.savePairing();this.changed();
    }
    this.lastSeen=now;
    return null;
  }
  async events(req,res,url,ip){
    const q=url.searchParams,d=q.get('d'),t=Number(q.get('t')),n=q.get('n'),s=q.get('s');
    const error=await this.verify(d,t,n,s,['GET','/api/events',d,t,n].join('\n'));
    if(error){if(error[0]===403)this.fail(ip);return this.reply(res,error[0],{error:error[1]});}
    this.endStream();
    res.writeHead(200,{...SECURITY_HEADERS,'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive'});
    const stream={res,ping:setInterval(()=>{try{res.write(': ping\n\n');}catch{}},15000)};
    this.stream=stream;this.changed();
    req.on('close',()=>{clearInterval(stream.ping);if(this.stream===stream){this.stream=null;this.lastSeen=this.now();this.changed();}});
    this.overview().then(o=>this.push('overview',o),()=>{});
    for(const r of this.bridge.requests.values())this.push('approval',simplifyRequest(r));
    for(const a of this.claude.approvals.values())this.push('approval',a.request);
    // A stale Claude reading is refreshed in the background when the phone connects.
    this.claudeUsage.read().then(u=>{if(!u||this.now()-u.at>10*60*1000)return this.refreshClaudeUsage();}).catch(()=>{});
  }
  endStream(){const s=this.stream;if(!s)return;this.stream=null;clearInterval(s.ping);try{s.res.end();}catch{}}
  push(event,data){
    const s=this.stream;if(!s)return;
    try{s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}catch{}
  }
  scheduleOverview(){
    if(!this.stream||this.overviewTimer)return;
    this.overviewTimer=setTimeout(()=>{this.overviewTimer=null;this.overview().then(o=>this.push('overview',o),()=>{});},800);
  }
  async readBody(req){
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new UserError('Nội dung quá dài.','PHONE_BODY');chunks.push(chunk);}
    return Buffer.concat(chunks).toString('utf8');
  }
  async call(req,res,ip){
    let raw;try{raw=await this.readBody(req);}catch(e){return this.reply(res,413,{error:publicError(e).message});}
    let body;try{body=JSON.parse(raw);}catch{return this.reply(res,400,{error:'Dữ liệu không hợp lệ.'});}
    if(!body||typeof body!=='object'||Array.isArray(body))return this.reply(res,400,{error:'Dữ liệu không hợp lệ.'});
    const error=await this.verify(body.d,body.t,body.n,req.headers['x-pad-signature'],['POST','/api/call',raw].join('\n'));
    if(error){if(error[0]===403)this.fail(ip);return this.reply(res,error[0],{error:error[1]});}
    const args=body.args&&typeof body.args==='object'&&!Array.isArray(body.args)?body.args:{};
    try{return this.reply(res,200,{ok:true,result:await this.command(String(body.cmd||''),args)});}
    catch(e){return this.reply(res,200,{ok:false,error:publicError(e).message,code:publicError(e).code});}
  }
  // ---------- commands (the complete list a phone may call) ----------
  async command(cmd,args){
    switch(cmd){
      case 'hello':return {version:this.version};
      case 'overview':return this.overview();
      case 'refreshQuota':await this.service.refreshAll();return this.overview();
      case 'useAccount':this.service.get(String(args.id));await this.actions.selectAccount(String(args.id));return this.overview();
      case 'sayHi':this.service.get(String(args.id));return this.service.sayHi.start(String(args.id));
      case 'claudeUsage':await this.refreshClaudeUsage(true);return this.overview();
      case 'kaggleRefresh':{const k=this.service.kaggle;if(!k)throw new UserError('Chưa có tài khoản Kaggle.','PHONE_KAGGLE');await k.refreshAll();return this.overview();}
      case 'threads':return this.threads(args);
      case 'folders':return {folders:await this.folderList(args.provider)};
      case 'thread':return isClaude(args.threadId)?this.claude.read(args.threadId):this.thread(args);
      case 'more':return isClaude(args.threadId)?this.claude.read(args.threadId,typeof args.cursor==='string'?args.cursor:null):this.more(args);
      case 'send':
        if(isClaude(args.threadId)){this.prompt(args.text);return this.claude.send({threadId:args.threadId,text:args.text,fork:args.fork===true});}
        return this.send(args);
      case 'newThread':
        if(args.provider==='claude'){this.prompt(args.text);return this.claude.newSession({cwd:args.cwd,text:args.text});}
        return this.newThread(args);
      case 'interrupt':return isClaude(args.threadId)?this.claude.interrupt(args.threadId):this.interrupt(args);
      case 'openOnComputer':return this.openOnComputer(args);
      case 'approve':
        if(String(args.id).startsWith('claude-'))this.claude.answer(String(args.id),String(args.decision));
        else this.bridge.answer(String(args.id),String(args.decision));
        return {ok:true};
      default:throw new UserError('Lệnh không được hỗ trợ.','PHONE_COMMAND');
    }
  }
  async refreshClaudeUsage(strict=false){
    if(this.usageFlight)return this.usageFlight;
    this.usageFlight=(async()=>{
      try{this.claudeUsage.fromUsage(await this.claude.usage());}
      catch(e){if(strict&&!(await this.claudeUsage.read()))throw e;}
      finally{this.usageFlight=null;}
      this.scheduleOverview();
    })();
    return this.usageFlight;
  }
  async overview(){
    const v=this.service.view(),g=v.gateway||{};
    const err=e=>!e?null:typeof e==='string'?e:e.message||null;
    const kaggle=this.service.kaggle?.view?.();
    return {
      version:v.version,
      gateway:{status:g.status,profileId:g.profileId||null,pendingId:g.pendingId||null,activeTurns:g.activeTurns||0,lastError:g.lastError||null},
      autoSwitch:!!v.autoSwitch?.enabled,
      sayHi:{running:!!v.sayHi?.active,profileId:v.sayHi?.activeProfileId||null},
      accounts:(v.profiles||[]).map(p=>({id:p.id,label:p.label,plan:p.plan||null,status:p.status,refreshing:!!p.refreshing,lastError:err(p.lastError),quotaAt:p.quotaAt||null,
        limits:(p.quota||[]).map(q=>({id:q.id,name:q.name||null,windows:(q.windows||[]).map(w=>({kind:w.kind,usedPercent:w.usedPercent,windowDurationMins:w.windowDurationMins,resetsAt:w.resetsAt}))}))})),
      claude:{usage:await this.claudeUsage.read().catch(()=>null),statusLine:this.claudeUsage.setup,refreshing:!!this.usageFlight,active:this.claude.active},
      kaggle:kaggle?{accounts:(kaggle.accounts||[]).map(a=>({id:a.id,label:a.label||a.username,username:a.username,status:a.status,refreshing:!!a.refreshing,
        lastError:err(a.lastError)||err(a.quotaError),quotaAt:a.quotaAt||null,notebooksAt:a.notebooksAt||null,
        quota:(a.quota||[]).map(q=>({resource:q.resource,used:q.used,total:q.total,remaining:q.remaining,refreshAt:q.refreshAt||null})),
        notebooks:(a.notebooks||[]).slice(0,15).map(n=>({ref:n.ref,title:n.title,status:n.status,accelerator:n.accelerator||null,lastRunAt:n.lastRunAt||null,watched:(a.watch||[]).includes(n.ref)}))}))}:{accounts:[]},
    };
  }
  // A notebook that leaves running/queued is announced once to the open phone page.
  watchKaggle(){
    const k=this.service.kaggle?.view?.();if(!k)return;
    const first=this.kaggleStates.size===0;
    for(const a of k.accounts||[])for(const n of a.notebooks||[]){
      const before=this.kaggleStates.get(n.ref);this.kaggleStates.set(n.ref,n.status);
      if(!first&&before&&before!==n.status&&['running','queued'].includes(before)&&!['running','queued'].includes(n.status))
        this.push('kaggle',{ref:n.ref,title:n.title||n.ref,status:n.status,account:a.label||a.username});
    }
  }
  async threads({cursor=null,search='',provider='all'}){
    const want=['codex','claude'].includes(provider)?provider:'all',notices=[],lists=[];let nextCursor=null;
    if(want!=='claude'){
      try{const r=await this.codexThreads({cursor,search});lists.push(...r.threads);nextCursor=want==='codex'?r.nextCursor:null;}
      catch(e){notices.push({provider:'codex',message:publicError(e).message});}
    }
    if(want!=='codex'&&!cursor){
      try{lists.push(...await this.claude.list({search}));}
      catch(e){notices.push({provider:'claude',message:publicError(e).message});}
    }
    lists.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    return {threads:lists,nextCursor,notices};
  }
  async codexThreads({cursor=null,search=''}){
    const params={limit:30,sortKey:'updated_at',sortDirection:'desc'};
    if(typeof cursor==='string'&&cursor.length<=2000)params.cursor=cursor;
    if(typeof search==='string'&&search.trim())params.searchTerm=search.trim().slice(0,200);
    const r=await this.bridge.request('thread/list',params);
    return {threads:(r.data||[]).filter(t=>!t.parentThreadId&&!t.ephemeral).map(t=>({...simplifyThread(t),provider:'codex'})),nextCursor:r.nextCursor||null};
  }
  // Folders where a Codex session already exists: the only places a phone may start one.
  async folders(fresh=false){
    if(!fresh&&this.folderCache&&this.now()-this.folderCache.at<60000)return this.folderCache.list;
    const seen=new Map();let cursor=null;
    for(let page=0;page<5;page++){
      const r=await this.bridge.request('thread/list',{limit:100,sortKey:'updated_at',sortDirection:'desc',...(cursor?{cursor}:{})});
      for(const t of r.data||[]){
        if(!t.cwd||t.ephemeral)continue;
        const key=path.win32.normalize(t.cwd).toLowerCase(),f=seen.get(key);
        // Pages come newest first, so the first thread seen is the folder's latest.
        if(f)f.count++;else seen.set(key,{path:t.cwd,name:path.win32.basename(t.cwd)||t.cwd,count:1,updatedAt:t.updatedAt||null,latest:t.path||null});
      }
      cursor=r.nextCursor;if(!cursor)break;
    }
    // A folder that was deleted or moved cannot host a new session.
    const list=[];
    for(const f of seen.values())if(await this.folderExists(f.path))list.push(f);
    this.folderCache={at:this.now(),list};return list;
  }
  // The phone sends only folder names and counts, never rollout paths.
  async folderList(provider){
    const list=provider==='claude'?await this.claude.folders(true):await this.folders(true);
    return list.map(({latest,...f})=>f);
  }
  async folderExists(folder){
    if(this.options?.folderExists)return this.options.folderExists(folder);
    try{return (await fs.stat(folder)).isDirectory();}catch{return false;}
  }
  async readTurns(threadId,cursor=null){
    try{
      const r=await this.bridge.request('thread/turns/list',{threadId,limit:12,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});
      return {turns:(r.data||[]).slice().reverse(),nextCursor:r.nextCursor||null};
    }catch(e){
      if(cursor)throw e;
      // Older Codex releases have no paginated turns.
      const r=await this.bridge.request('thread/read',{threadId,includeTurns:true});
      const all=r.thread?.turns||[];return {turns:all.slice(-12),nextCursor:null};
    }
  }
  async thread({threadId}){
    if(!THREAD_ID.test(String(threadId)))throw new UserError('Session không hợp lệ.','PHONE_THREAD');
    // Subscribe before reading, so no event falls between the read and the live stream.
    let live=true;try{await this.bridge.subscribe(threadId);}catch{live=false;}
    const meta=await this.bridge.request('thread/read',{threadId,includeTurns:false});
    const [{turns,nextCursor},mode]=await Promise.all([this.readTurns(threadId),codexMode(meta.thread?.path)]);
    return {thread:{...simplifyThread(meta.thread||{}),provider:'codex',mode:mode?.label||null},turns:turns.map(simplifyTurn),nextCursor,live,
      approvals:[...this.bridge.requests.values()].filter(r=>r.params?.threadId===threadId).map(simplifyRequest)};
  }
  async more({threadId,cursor}){
    if(!THREAD_ID.test(String(threadId))||typeof cursor!=='string'||cursor.length>2000)throw new UserError('Yêu cầu không hợp lệ.','PHONE_THREAD');
    const {turns,nextCursor}=await this.readTurns(threadId,cursor);
    return {turns:turns.map(simplifyTurn),nextCursor};
  }
  prompt(text){
    if(typeof text!=='string'||!text.trim())throw new UserError('Nhập nội dung trước khi gửi.','PHONE_PROMPT');
    if(text.length>MAX_PROMPT)throw new UserError('Nội dung quá dài (tối đa 20.000 ký tự).','PHONE_PROMPT');
    return [{type:'text',text}];
  }
  // The turn keeps the approval and sandbox mode the session last ran with on the
  // computer. Without them Codex falls back to config.toml and asks about every command.
  async startTurn(threadId,input,mode=null){
    const r=await this.bridge.request('turn/start',{threadId,input,...codexTurnParams(mode)});
    const turnId=r?.turn?.id||null;if(turnId){this.phoneTurns.add(turnId);this.changed();}
    return turnId;
  }
  async send({threadId,text}){
    if(!THREAD_ID.test(String(threadId)))throw new UserError('Session không hợp lệ.','PHONE_THREAD');
    const input=this.prompt(text);
    const meta=await this.bridge.request('thread/read',{threadId,includeTurns:false});
    if(meta.thread?.status?.type==='active')throw new UserError('Session đang chạy. Chờ lượt hiện tại xong hoặc bấm Dừng.','PHONE_THREAD_ACTIVE');
    await this.bridge.subscribe(threadId);
    return {threadId,turnId:await this.startTurn(threadId,input,await codexMode(meta.thread?.path))};
  }
  async newThread({cwd,text}){
    const input=this.prompt(text);
    if(typeof cwd!=='string'||!cwd||cwd.length>1024)throw new UserError('Chọn thư mục cho session mới.','PHONE_FOLDER');
    let folder=(await this.folders()).find(f=>samePath(f.path,cwd));
    if(!folder)folder=(await this.folders(true)).find(f=>samePath(f.path,cwd));
    if(!folder)throw new UserError('Chỉ tạo session trong thư mục đã từng có session Codex.','PHONE_FOLDER');
    // The folder's recorded path is used, never the phone's spelling of it.
    const r=await this.bridge.request('thread/start',{cwd:folder.path});
    const threadId=r?.thread?.id;if(!threadId)throw new UserError('Codex chưa tạo được session.','PHONE_THREAD');
    this.bridge.subscribed.add(threadId);
    // A new session takes the mode of the folder's latest session.
    return {threadId,turnId:await this.startTurn(threadId,input,await codexMode(folder.latest))};
  }
  // Opens the session on this computer: in VS Code through the extension's own link, or,
  // for a Claude session the extension hides, in Claude Code in a terminal.
  async openOnComputer({threadId}){
    let target;
    if(isClaude(threadId))target=await this.claude.computerTarget(threadId);
    else{
      if(!THREAD_ID.test(String(threadId)))throw new UserError('Session không hợp lệ.','PHONE_THREAD');
      target={link:'vscode://openai.chatgpt/local/'+threadId};
    }
    const action=target.terminal?this.actions?.openTerminal:this.actions?.openLink;
    if(typeof action!=='function')throw new UserError('Máy tính này chưa mở được session từ điện thoại.','PHONE_OPEN');
    await action(target.terminal||target.link);
    return {opened:target.terminal?'terminal':'vscode'};
  }
  async interrupt({threadId}){
    if(!THREAD_ID.test(String(threadId)))throw new UserError('Session không hợp lệ.','PHONE_THREAD');
    const {turns}=await this.readTurns(threadId);
    const turn=turns.slice().reverse().find(t=>t.status==='inProgress');
    if(!turn)throw new UserError('Không có lượt nào đang chạy.','PHONE_NO_TURN');
    await this.bridge.request('turn/interrupt',{threadId,turnId:turn.id});
    return {turnId:turn.id};
  }
  forward(method,p){
    if(method==='turn/completed'&&p.turn?.id&&this.phoneTurns.delete(p.turn.id))this.changed();
    if(!this.stream)return;
    switch(method){
      case 'item/agentMessage/delta':return this.push('live',{method,threadId:p.threadId,turnId:p.turnId,itemId:p.itemId,delta:String(p.delta||'')});
      case 'item/started':case 'item/completed':return this.push('live',{method,threadId:p.threadId,turnId:p.turnId,item:simplifyItem(p.item||{})});
      case 'turn/started':case 'turn/completed':return this.push('live',{method,threadId:p.threadId,turn:simplifyTurn(p.turn||{})});
      case 'thread/status/changed':return this.push('live',{method,threadId:p.threadId,status:p.status?.type||null});
      case 'error':return this.push('live',{method,threadId:p.threadId,turnId:p.turnId,message:String(p.error?.message||'Codex báo lỗi.').slice(0,500),willRetry:!!p.willRetry});
      default:return;
    }
  }
}
module.exports={PhoneRemote,privateAddress,lanAddresses,sign,DEFAULT_PORT,PHONE_LINK};
