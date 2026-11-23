'use strict';
// Reduces Codex protocol objects to what a phone screen shows. Large outputs are cut,
// diffs are left out and unknown item types keep only their name.
const tail=(text,max)=>{const s=String(text??'');return s.length>max?'…'+s.slice(-max):s;};
const head=(text,max)=>{const s=String(text??'');return s.length>max?s.slice(0,max)+'…':s;};
function inputText(content){
  if(!Array.isArray(content))return {text:'',attachments:0};
  const text=content.filter(c=>c?.type==='text').map(c=>c.text||'').join('\n');
  return {text,attachments:content.filter(c=>c&&c.type!=='text').length};
}
function simplifyItem(item){
  const id=item?.id||null;
  switch(item?.type){
    case 'userMessage':{const {text,attachments}=inputText(item.content);return {id,type:'user',text:head(text,8000),attachments};}
    case 'agentMessage':return {id,type:'agent',text:head(item.text,20000)};
    case 'reasoning':return {id,type:'reasoning',text:head((item.summary||[]).join('\n'),2000)};
    case 'plan':return {id,type:'plan',text:head(item.text,4000)};
    case 'commandExecution':return {id,type:'command',command:head(item.command,1000),cwd:item.cwd||null,status:item.status||null,exitCode:item.exitCode??null,output:tail(item.aggregatedOutput,2000),durationMs:item.durationMs??null};
    case 'fileChange':return {id,type:'files',status:item.status||null,changes:(item.changes||[]).slice(0,50).map(c=>({path:String(c.path||''),kind:c.kind?.type||null}))};
    case 'mcpToolCall':return {id,type:'tool',name:[item.server,item.tool].filter(Boolean).join(' · '),status:item.status||null};
    case 'dynamicToolCall':return {id,type:'tool',name:item.tool||'tool',status:item.status||null};
    case 'webSearch':return {id,type:'search',query:head(item.query||'',300)};
    case 'contextCompaction':return {id,type:'note',text:'Đã nén ngữ cảnh hội thoại'};
    case 'enteredReviewMode':case 'exitedReviewMode':return {id,type:'note',text:item.type==='enteredReviewMode'?'Bắt đầu review':'Kết thúc review'};
    default:return {id,type:'other',kind:String(item?.type||'unknown')};
  }
}
function simplifyTurn(turn){
  return {id:turn?.id||null,status:turn?.status||null,error:turn?.error?.message?head(turn.error.message,500):null,
    startedAt:turn?.startedAt??null,completedAt:turn?.completedAt??null,durationMs:turn?.durationMs??null,
    items:(turn?.items||[]).filter(i=>i?.type!=='hookPrompt').map(simplifyItem)};
}
function sourceName(source){if(typeof source==='string')return source;if(source&&typeof source==='object')return Object.keys(source)[0]||null;return null;}
function simplifyThread(t){
  return {id:t.id,title:head(t.name||t.preview||'',160)||null,preview:head(t.preview||'',300),cwd:t.cwd||null,
    status:t.status?.type||null,waiting:Array.isArray(t.status?.activeFlags)?t.status.activeFlags:[],
    updatedAt:t.updatedAt??null,createdAt:t.createdAt??null,model:t.model||null,source:sourceName(t.source),branch:t.gitInfo?.branch||null};
}
function simplifyRequest(r){
  const p=r.params||{};
  const kind=r.method==='item/commandExecution/requestApproval'?'command':r.method==='item/fileChange/requestApproval'?'files':'other';
  return {id:String(r.id),method:r.method,kind,answerable:!!r.answerable,threadId:p.threadId||null,turnId:p.turnId||null,itemId:p.itemId||null,
    command:p.command?head(p.command,2000):null,cwd:p.cwd||null,reason:p.reason?head(p.reason,1000):null,grantRoot:p.grantRoot||null,at:r.at};
}
module.exports={simplifyItem,simplifyTurn,simplifyThread,simplifyRequest};
