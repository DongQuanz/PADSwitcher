'use strict';
// The permission mode a session last ran with on the computer. The phone continues a
// session in that same mode, so a session the user runs with full access on the laptop
// does not start asking about every command when it is continued from the phone.
const fs=require('node:fs/promises');

const CHUNK=256*1024;
const LIMIT=64*1024*1024;

// The last line of a JSONL file for which `pick` returns a value, read backwards in
// chunks so a long session is not read whole. Only lines containing `needle` are parsed.
async function lastMatch(file,needle,pick,limit=LIMIT){
  if(typeof file!=='string'||!file)return null;
  let handle;try{handle=await fs.open(file,'r');}catch{return null;}
  try{
    const size=(await handle.stat()).size;
    let end=size,carry=Buffer.alloc(0);
    while(end>0&&size-end<limit){
      const start=Math.max(0,end-CHUNK),chunk=Buffer.alloc(end-start);
      await handle.read(chunk,0,chunk.length,start);
      const data=Buffer.concat([chunk,carry]);
      // Before the first newline is the tail of a line that began in an earlier chunk.
      const cut=start>0?data.indexOf(10):-1;
      if(start>0&&cut<0){carry=data;end=start;continue;}
      const lines=data.subarray(cut+1).toString('utf8').split('\n');
      for(let i=lines.length-1;i>=0;i--){
        if(!lines[i].includes(needle))continue;
        let value;try{value=pick(JSON.parse(lines[i]));}catch{value=null;}
        if(value!=null)return value;
      }
      carry=start>0?data.subarray(0,cut):Buffer.alloc(0);end=start;
    }
    return null;
  }finally{await handle.close();}
}

const CODEX_APPROVALS=new Set(['untrusted','on-request','never']);
// Rollout files record the sandbox in the core format; turn/start takes the v2 format.
function codexSandbox(p){
  switch(p?.type){
    case 'danger-full-access':return {type:'dangerFullAccess'};
    case 'read-only':return {type:'readOnly',networkAccess:p.network_access===true};
    case 'workspace-write':return {type:'workspaceWrite',writableRoots:Array.isArray(p.writable_roots)?p.writable_roots.filter(r=>typeof r==='string'):[],
      networkAccess:p.network_access===true,excludeTmpdirEnvVar:p.exclude_tmpdir_env_var===true,excludeSlashTmp:p.exclude_slash_tmp===true};
    default:return null;
  }
}
function codexLabel(approval,sandbox){
  if(sandbox?.type==='dangerFullAccess'&&approval==='never')return 'Toàn quyền';
  if(sandbox?.type==='readOnly')return 'Chỉ đọc';
  if(approval==='never')return 'Không hỏi';
  if(approval==='untrusted')return 'Hỏi nhiều';
  return 'Hỏi khi cần';
}
async function codexMode(file){
  return lastMatch(file,'"turn_context"',line=>{
    if(line?.type!=='turn_context')return null;
    const p=line.payload||{},approvalPolicy=CODEX_APPROVALS.has(p.approval_policy)?p.approval_policy:null,sandboxPolicy=codexSandbox(p.sandbox_policy);
    if(!approvalPolicy&&!sandboxPolicy)return null;
    return {approvalPolicy,sandboxPolicy,label:codexLabel(approvalPolicy,sandboxPolicy)};
  });
}
// Overrides for turn/start: they apply to this turn and the ones after it.
const codexTurnParams=mode=>({...(mode?.approvalPolicy?{approvalPolicy:mode.approvalPolicy}:{}),...(mode?.sandboxPolicy?{sandboxPolicy:mode.sandboxPolicy}:{})});

const CLAUDE_MODES={auto:'Auto',acceptEdits:'Tự sửa tệp',default:'Hỏi trước',plan:'Lập kế hoạch',bypassPermissions:'Toàn quyền',dontAsk:'Không hỏi'};
const claudeModeOf=value=>Object.prototype.hasOwnProperty.call(CLAUDE_MODES,value)?value:null;
async function claudeMode(file){
  return lastMatch(file,'"permissionMode"',line=>claudeModeOf(line?.permissionMode));
}
const claudeLabel=mode=>CLAUDE_MODES[mode]||null;

module.exports={lastMatch,codexMode,codexTurnParams,codexSandbox,claudeMode,claudeModeOf,claudeLabel};
