'use strict';
// Claude Code sessions for the phone remote, through the Claude Agent SDK. Sessions run
// with the user's own Claude Code installation and sign-in. Every tool permission that
// Claude Code would ask about in a terminal is asked on the phone instead.
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UserError}=require('../core/errors.cjs');
const {buildTurns,toolItem,finishTool,ItemIds,cleanPrompt}=require('./claude-present.cjs');
const {claudeMode,claudeModeOf,claudeLabel}=require('./modes.cjs');

const SESSION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX='claude:';
const PAGE=12;
const head=(text,max)=>{const s=String(text??'');return s.length>max?s.slice(0,max)+'…':s;};
const pidAliveDefault=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const withTimeout=(promise,ms,message)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new UserError(message,'CLAUDE_TIMEOUT')),ms);t.unref?.();})]);
function sessionOf(threadId){
  const id=String(threadId||'');
  if(!id.startsWith(PREFIX)||!SESSION_ID.test(id.slice(PREFIX.length)))throw new UserError('Session Claude không hợp lệ.','CLAUDE_SESSION');
  return id.slice(PREFIX.length);
}
const isClaude=threadId=>String(threadId||'').startsWith(PREFIX);
// The VS Code extension hides a session whose first recorded entrypoint is one of these,
// and its open link then shows an empty chat. Such sessions open in a terminal instead.
const SDK_ENTRYPOINTS=new Set(['sdk-cli','sdk-ts','sdk-py']);
async function firstEntrypoint(file){
  if(!file)return null;
  let handle;
  try{
    handle=await fs.open(file,'r');
    const buffer=Buffer.alloc(64*1024),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
    return /"entrypoint":\s*"([^"\\]*)"/.exec(buffer.toString('utf8',0,bytesRead))?.[1]??null;
  }catch{return null;}finally{await handle?.close();}
}
const where=entry=>entry?.entrypoint==='claude-vscode'?'VS Code':entry?.entrypoint==='cli'?'terminal':entry?.entrypoint==='claude-desktop'?'Claude Desktop':'Claude Code';

class ClaudeBridge extends EventEmitter{
  constructor({home=os.homedir(),loadSdk=()=>import('@anthropic-ai/claude-agent-sdk'),executable,now=()=>Date.now(),pidAlive=pidAliveDefault,folderExists,closeGrace=5000}={}){
    super();this.home=home;this.loadSdk=loadSdk;this.executablePath=executable;this.now=now;this.pidAlive=pidAlive;this.folderExists=folderExists;this.closeGrace=closeGrace;
    this.runs=new Map();this.approvals=new Map();this.sdkFlight=null;this.folderCache=null;
  }
  async sdk(){
    if(!this.sdkFlight)this.sdkFlight=Promise.resolve().then(()=>this.loadSdk()).catch(error=>{this.sdkFlight=null;throw new UserError('Chưa tải được Claude Agent SDK. Cài lại PADSwitcher.','CLAUDE_SDK');});
    return this.sdkFlight;
  }
  // The user's Claude Code keeps their sign-in, settings and version. The SDK's own
  // copy is the fallback during development.
  async executable(){
    if(this.executablePath!==undefined)return this.executablePath;
    const names=process.platform==='win32'?['claude.exe']:['claude'];
    const dirs=[path.join(this.home,'.local','bin'),...String(process.env.PATH||'').split(path.delimiter).filter(Boolean)];
    for(const dir of dirs)for(const name of names){
      const file=path.join(dir,name);
      try{if((await fs.stat(file)).isFile())return this.executablePath=file;}catch{}
    }
    return this.executablePath=null;
  }
  async available(){try{await this.sdk();return true;}catch{return false;}}
  // Claude Code records each open interactive session in ~/.claude/sessions/<pid>.json.
  // The format is internal, so it is read only to show status and avoid two writers.
  async registry(){
    const dir=path.join(this.home,'.claude','sessions'),map=new Map();
    let names=[];try{names=await fs.readdir(dir);}catch{return map;}
    for(const name of names){
      if(!/^\d+\.json$/.test(name))continue;
      try{
        const entry=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
        if(!SESSION_ID.test(String(entry.sessionId))||!Number.isInteger(entry.pid)||this.runs.has(entry.sessionId)||!this.pidAlive(entry.pid))continue;
        map.set(entry.sessionId,{pid:entry.pid,status:entry.status==='busy'?'busy':'idle',entrypoint:String(entry.entrypoint||'')});
      }catch{}
    }
    return map;
  }
  thread(s,registry){
    const run=this.runs.get(s.sessionId),open=registry.get(s.sessionId);
    const waiting=[...this.approvals.values()].some(a=>a.run.sessionId===s.sessionId)?['waitingOnApproval']:[];
    const title=cleanPrompt(s.customTitle||s.summary||s.firstPrompt||'');
    return {id:PREFIX+s.sessionId,provider:'claude',title:head(title,160)||null,preview:head(cleanPrompt(s.firstPrompt||''),300),cwd:s.cwd||null,
      status:run||open?.status==='busy'?'active':'idle',waiting,updatedAt:Math.floor((s.lastModified||0)/1000)||null,createdAt:s.createdAt?Math.floor(s.createdAt/1000):null,
      branch:s.gitBranch||null,openElsewhere:open?where(open):null};
  }
  async list({search=''}={}){
    const sdk=await this.sdk();const [sessions,registry]=await Promise.all([sdk.listSessions({limit:80}),this.registry()]);
    const term=String(search||'').trim().toLowerCase();
    return sessions.filter(s=>!s.archived).map(s=>this.thread(s,registry)).filter(t=>!term||`${t.title||''} ${t.preview} ${t.cwd||''}`.toLowerCase().includes(term)).slice(0,40);
  }
  async exists(folder){
    if(this.folderExists)return this.folderExists(folder);
    try{return (await fs.stat(folder)).isDirectory();}catch{return false;}
  }
  async folders(fresh=false){
    if(!fresh&&this.folderCache&&this.now()-this.folderCache.at<60000)return this.folderCache.list;
    const sdk=await this.sdk(),seen=new Map();
    for(const s of await sdk.listSessions({limit:500})){
      if(!s.cwd)continue;const key=path.win32.normalize(s.cwd).toLowerCase(),f=seen.get(key),at=s.lastModified||0;
      if(f){f.count++;if(at>f.latestAt){f.latestAt=at;f.latest=s.sessionId;}f.updatedAt=Math.floor(f.latestAt/1000);}
      else seen.set(key,{path:s.cwd,name:path.win32.basename(s.cwd)||s.cwd,count:1,updatedAt:Math.floor(at/1000),latest:s.sessionId,latestAt:at});
    }
    for(const f of seen.values())delete f.latestAt;
    const list=[];for(const f of seen.values())if(await this.exists(f.path))list.push(f);
    this.folderCache={at:this.now(),list};return list;
  }
  async read(threadId,cursor=null){
    const sessionId=sessionOf(threadId),sdk=await this.sdk();
    const [info,messages,registry]=await Promise.all([sdk.getSessionInfo(sessionId),sdk.getSessionMessages(sessionId,{}),this.registry()]);
    if(!info)throw new UserError('Không tìm thấy session Claude này.','CLAUDE_SESSION');
    const active=this.runs.has(sessionId)||registry.get(sessionId)?.status==='busy';
    const turns=buildTurns(messages,{active}),mode=await this.sessionMode(sessionId,info.cwd);
    const skip=cursor==null?0:Math.max(0,Number.parseInt(cursor,10)||0),end=Math.max(0,turns.length-skip),start=Math.max(0,end-PAGE);
    return {thread:{...this.thread(info,registry),mode:claudeLabel(mode)},turns:turns.slice(start,end),nextCursor:start>0?String(turns.length-start):null,live:true,
      approvals:[...this.approvals.values()].filter(a=>a.run.sessionId===sessionId).map(a=>a.request)};
  }
  async send({threadId,text,fork=false}){
    const sessionId=sessionOf(threadId);
    if(this.runs.has(sessionId))throw new UserError('Session đang chạy. Chờ lượt hiện tại xong hoặc bấm Dừng.','PHONE_THREAD_ACTIVE');
    const open=(await this.registry()).get(sessionId);
    if(open&&!fork)throw new UserError(`Session này đang mở trong ${where(open)}. Gửi từ điện thoại sẽ tạo một nhánh mới để không ghi chồng lên nó.`,'CLAUDE_OPEN_ELSEWHERE');
    const info=await (await this.sdk()).getSessionInfo(sessionId);
    if(!info)throw new UserError('Không tìm thấy session Claude này.','CLAUDE_SESSION');
    // A branch keeps the mode of the session it branches from.
    return this.start({text,cwd:info.cwd||this.home,resume:sessionId,fork:!!fork,mode:await this.sessionMode(sessionId,info.cwd)});
  }
  // Where the computer can show this session: the VS Code extension's own link, or
  // Claude Code resuming it in a terminal when the extension hides it (a session the
  // phone started or branched). The terminal writes the same session, so the phone
  // sees what is typed there.
  async computerTarget(threadId){
    const sessionId=sessionOf(threadId);
    // Two Claude Code processes must not write one session.
    if(this.runs.has(sessionId))throw new UserError('Chờ lượt trên điện thoại xong rồi mở trên máy tính.','PHONE_THREAD_ACTIVE');
    const info=await (await this.sdk()).getSessionInfo(sessionId);
    if(!info)throw new UserError('Không tìm thấy session Claude này.','CLAUDE_SESSION');
    if(!SDK_ENTRYPOINTS.has(await firstEntrypoint(await this.sessionFile(sessionId,info.cwd))))return {link:'vscode://anthropic.claude-code/open?session='+sessionId};
    const open=(await this.registry()).get(sessionId);
    if(open)throw new UserError(`Session này đang mở trong ${where(open)} trên máy tính.`,'CLAUDE_OPEN_ELSEWHERE');
    const file=await this.executable();
    if(!file)throw new UserError('Không tìm thấy Claude Code trên máy tính để mở session này.','CLAUDE_CLI');
    return {terminal:{file,cwd:info.cwd||this.home,sessionId}};
  }
  async newSession({cwd,text}){
    if(typeof cwd!=='string'||!cwd||cwd.length>1024)throw new UserError('Chọn thư mục cho session mới.','PHONE_FOLDER');
    const same=f=>path.win32.normalize(f.path).replace(/[\\/]+$/,'').toLowerCase()===path.win32.normalize(cwd).replace(/[\\/]+$/,'').toLowerCase();
    const folder=(await this.folders()).find(same)||(await this.folders(true)).find(same);
    if(!folder)throw new UserError('Chỉ tạo session trong thư mục đã từng có session Claude.','PHONE_FOLDER');
    // A new session takes the mode of the folder's latest session.
    return this.start({text,cwd:folder.path,mode:await this.sessionMode(folder.latest,folder.path)});
  }
  // Claude Code stores a session at ~/.claude/projects/<cwd with every other character
  // replaced by '-'>/<id>.jsonl. Very long folder names are shortened, so fall back to a scan.
  async sessionFile(sessionId,cwd){
    if(!SESSION_ID.test(String(sessionId||'')))return null;
    const root=path.join(this.home,'.claude','projects'),name=sessionId+'.jsonl';
    const exists=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}};
    if(cwd){const file=path.join(root,String(cwd).replace(/[^a-zA-Z0-9]/g,'-'),name);if(await exists(file))return file;}
    let dirs=[];try{dirs=await fs.readdir(root);}catch{return null;}
    for(const dir of dirs){const file=path.join(root,dir,name);if(await exists(file))return file;}
    return null;
  }
  // The permission mode the session last ran with, else the user's settings default.
  // Without it the phone runs in 'default' mode and asks about nearly every tool.
  async sessionMode(sessionId,cwd){
    const recorded=await claudeMode(await this.sessionFile(sessionId,cwd));
    if(recorded)return recorded;
    try{return claudeModeOf(JSON.parse(await fs.readFile(path.join(this.home,'.claude','settings.json'),'utf8'))?.permissions?.defaultMode);}catch{return null;}
  }
  async start({text,cwd,resume=null,fork=false,mode=null}){
    const sdk=await this.sdk(),exe=await this.executable(),turnId=crypto.randomUUID();
    let finishInput;const inputDone=new Promise(resolve=>{finishInput=resolve;});
    async function* input(){yield {type:'user',uuid:turnId,message:{role:'user',content:text},parent_tool_use_id:null};await inputDone;}
    const run={sessionId:resume&&!fork?resume:null,turnId,text,cwd,query:null,finishInput,ids:new ItemIds(),streamed:new Map(),seen:new Map(),index:new Map(),items:new Map(),result:null,ready:null};
    const ready=new Promise((resolve,reject)=>{run.ready={resolve,reject};});ready.catch(()=>{});
    if(run.sessionId)this.runs.set(run.sessionId,run);
    try{
      run.query=sdk.query({prompt:input(),options:{cwd,includePartialMessages:true,settingSources:['user','project','local'],
        canUseTool:(tool,toolInput,options)=>this.permission(run,tool,toolInput,options),
        ...(mode?{permissionMode:mode}:{}),...(mode==='bypassPermissions'?{allowDangerouslySkipPermissions:true}:{}),
        ...(resume?{resume}:{}),...(fork?{forkSession:true}:{}),...(exe?{pathToClaudeCodeExecutable:exe}:{}),stderr:()=>{}}});
    }catch(error){if(run.sessionId)this.runs.delete(run.sessionId);throw new UserError('Chưa khởi động được Claude Code.','CLAUDE_START');}
    this.consume(run).catch(()=>{}).finally(()=>this.end(run));
    const sessionId=await withTimeout(ready,90000,'Claude Code khởi động quá lâu. Kiểm tra Claude Code trên máy tính.');
    return {threadId:PREFIX+sessionId,turnId};
  }
  live(run,method,fields){this.emit('live',{method,threadId:PREFIX+run.sessionId,turnId:run.turnId,...fields});}
  async consume(run){for await(const m of run.query)this.handle(run,m);}
  handle(run,m){
    if(m.type==='system'&&m.subtype==='init'){
      if(!run.sessionId||run.sessionId!==m.session_id){if(run.sessionId)this.runs.delete(run.sessionId);run.sessionId=m.session_id;}
      if(!run.started){
        run.started=true;this.runs.set(run.sessionId,run);run.ready.resolve(run.sessionId);
        this.live(run,'turn/started',{turn:{id:run.turnId,status:'inProgress',items:[{id:run.turnId,type:'user',text:head(run.text,8000),attachments:0}]}});
        this.live(run,'thread/status/changed',{status:'active'});this.emit('changed');
      }
      return;
    }
    if(!run.sessionId)return;
    if(m.type==='rate_limit_event'){this.emit('rateLimit',m.rate_limit_info);return;}
    if(m.type==='system'&&m.subtype==='session_state_changed'){this.live(run,'thread/status/changed',{status:m.state==='idle'?'idle':'active'});return;}
    if(m.parent_tool_use_id)return; // a subagent's inner steps stay inside its tool call
    if(m.type==='stream_event'){
      const e=m.event;
      if(e?.type==='message_start'){run.messageId=e.message?.id||m.uuid;run.index.clear();}
      else if(e?.type==='content_block_start'&&e.content_block?.type==='text'){
        const id=run.ids.text(run.messageId);run.index.set(e.index,id);
        const list=run.streamed.get(run.messageId)||[];list.push(id);run.streamed.set(run.messageId,list);
        this.live(run,'item/started',{item:{id,type:'agent',text:''}});
      }else if(e?.type==='content_block_delta'&&e.delta?.type==='text_delta'&&run.index.has(e.index))this.live(run,'item/agentMessage/delta',{itemId:run.index.get(e.index),delta:String(e.delta.text||'')});
      return;
    }
    if(m.type==='assistant'){
      const messageId=m.message?.id||m.uuid;
      for(const b of Array.isArray(m.message?.content)?m.message.content:[]){
        if(b?.type==='text'&&b.text?.trim()){
          const n=run.seen.get(messageId)||0;run.seen.set(messageId,n+1);
          const id=run.streamed.get(messageId)?.[n]||run.ids.text(messageId);
          this.live(run,'item/completed',{item:{id,type:'agent',text:head(b.text,20000)}});
        }else if(b?.type==='tool_use'){const item=toolItem(b);run.items.set(b.id,item);this.live(run,'item/started',{item});}
      }
      return;
    }
    if(m.type==='user'&&Array.isArray(m.message?.content)){
      for(const b of m.message.content)if(b?.type==='tool_result'){const item=run.items.get(b.tool_use_id);if(item){finishTool(item,b);this.live(run,'item/completed',{item});}}
      return;
    }
    if(m.type==='result'){
      run.result=m;
      const ok=m.subtype==='success'&&!m.is_error;
      const error=ok?null:m.subtype==='success'?head(m.result||'Claude báo lỗi.',500):head((m.errors||[]).join('; ')||'Claude dừng lượt này.',500);
      this.live(run,'turn/completed',{turn:{id:run.turnId,status:ok?'completed':'failed',error,durationMs:m.duration_ms??null,items:[]}});
      run.finishInput();
      // Closing the input normally ends Claude Code, but it can wait on an 'idle' state that
      // never comes. A process left running keeps the session locked against VS Code.
      clearTimeout(run.closeTimer);
      run.closeTimer=setTimeout(()=>{try{run.query?.close?.();}catch{}},this.closeGrace);run.closeTimer.unref?.();
    }
  }
  end(run){
    clearTimeout(run.closeTimer);run.finishInput();
    for(const [id,a]of this.approvals)if(a.run===run)a.done({behavior:'deny',message:'Lượt đã kết thúc.'});
    if(!run.started)run.ready.reject(new UserError('Claude Code dừng trước khi bắt đầu. Kiểm tra đăng nhập Claude Code trên máy tính.','CLAUDE_START'));
    else{
      if(!run.result)this.live(run,'turn/completed',{turn:{id:run.turnId,status:run.interrupted?'interrupted':'failed',error:run.interrupted?null:'Claude Code dừng giữa chừng.',durationMs:null,items:[]}});
      this.live(run,'thread/status/changed',{status:'idle'});
    }
    if(this.runs.get(run.sessionId)===run)this.runs.delete(run.sessionId);
    this.emit('changed');
  }
  permission(run,toolName,input,options={}){
    if(toolName==='AskUserQuestion')return Promise.resolve({behavior:'deny',message:'Người dùng đang điều khiển từ điện thoại và không trả lời được câu hỏi trắc nghiệm. Hãy hỏi lại bằng một câu hỏi văn bản ngắn trong câu trả lời.'});
    const id='claude-'+crypto.randomUUID(),item=toolItem({id:options.toolUseID,name:toolName,input});
    const request={id,provider:'claude',method:'claude/permission',kind:item.type==='command'?'command':item.type==='files'?'files':'other',answerable:true,
      threadId:PREFIX+run.sessionId,turnId:run.turnId,itemId:options.toolUseID||null,tool:toolName,
      command:item.type==='command'?item.command:item.type==='tool'?item.name:null,cwd:run.cwd||null,
      reason:options.decisionReason?head(options.decisionReason,1000):null,grantRoot:options.blockedPath||null,
      files:item.type==='files'?item.changes.map(c=>c.path):[],at:this.now()};
    return new Promise(resolve=>{
      const abort=()=>done({behavior:'deny',message:'Đã hủy.'});
      const done=result=>{if(!this.approvals.has(id))return;this.approvals.delete(id);options.signal?.removeEventListener?.('abort',abort);this.emit('resolved',id);this.emit('changed');resolve(result);};
      options.signal?.addEventListener?.('abort',abort,{once:true});
      this.approvals.set(id,{request,run,input,suggestions:Array.isArray(options.suggestions)?options.suggestions:[],done});
      this.emit('request',request);this.emit('changed');
    });
  }
  answer(id,decision){
    const a=this.approvals.get(String(id));
    if(!a)throw new UserError('Yêu cầu duyệt này đã được xử lý hoặc không còn.','PHONE_APPROVAL_GONE');
    if(decision==='accept')a.done({behavior:'allow',updatedInput:a.input});
    // "Always" from the phone never writes a settings file: rules last for this run only.
    else if(decision==='acceptForSession')a.done({behavior:'allow',updatedInput:a.input,updatedPermissions:a.suggestions.filter(s=>s?.type==='addRules').map(s=>({...s,destination:'session'}))});
    else if(decision==='decline')a.done({behavior:'deny',message:'Người dùng đã từ chối trên điện thoại.'});
    else throw new UserError('Lựa chọn duyệt không hợp lệ.','PHONE_APPROVAL_INVALID');
  }
  async interrupt(threadId){
    const sessionId=sessionOf(threadId),run=this.runs.get(sessionId);
    if(run){run.interrupted=true;await run.query.interrupt();return {turnId:run.turnId};}
    const open=(await this.registry()).get(sessionId);
    if(open?.status==='busy')throw new UserError(`Session đang chạy trong ${where(open)}. Dừng nó trên máy tính.`,'CLAUDE_OPEN_ELSEWHERE');
    throw new UserError('Không có lượt nào đang chạy.','PHONE_NO_TURN');
  }
  // Plan usage without a model call. The SDK marks this method experimental, so a
  // missing or failing method only means the other usage sources are shown.
  async usage(){
    const sdk=await this.sdk(),exe=await this.executable();let finish;const idle=new Promise(resolve=>{finish=resolve;});
    async function* nothing(){await idle;}
    const q=sdk.query({prompt:nothing(),options:{cwd:this.home,settingSources:[],...(exe?{pathToClaudeCodeExecutable:exe}:{}),stderr:()=>{}}});
    try{
      const read=q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if(typeof read!=='function')throw new UserError('Phiên bản Claude Code này chưa cho đọc quota trực tiếp.','CLAUDE_USAGE_UNSUPPORTED');
      return await withTimeout(read.call(q,{skipBehaviors:true}),30000,'Claude Code chưa trả về quota.');
    }finally{finish();try{q.close?.();}catch{}}
  }
  get active(){return this.runs.size;}
  closeAll(){for(const run of this.runs.values()){run.interrupted=true;run.finishInput();try{run.query?.close?.();}catch{}}}
}
module.exports={ClaudeBridge,sessionOf,isClaude,PREFIX,SESSION_ID};
