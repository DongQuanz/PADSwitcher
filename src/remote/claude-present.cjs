'use strict';
// Turns Claude Code transcript messages (Anthropic message params) into the same
// turn/item shape the phone shows for Codex. A turn starts at each prompt typed by a
// person; tool results attach to the tool call that produced them.
const tail=(text,max)=>{const s=String(text??'');return s.length>max?'…'+s.slice(-max):s;};
const head=(text,max)=>{const s=String(text??'');return s.length>max?s.slice(0,max)+'…':s;};
const EDIT_TOOLS=new Set(['Edit','Write','MultiEdit','NotebookEdit']);
// IDE context and reminders injected around a prompt are not what the person typed.
function cleanPrompt(text){
  return String(text||'')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,'')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g,'')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g,'')
    .trim();
}
function blocks(content){return typeof content==='string'?[{type:'text',text:content}]:Array.isArray(content)?content:[];}
function resultText(content){
  if(typeof content==='string')return content;
  if(Array.isArray(content))return content.map(c=>c?.type==='text'?c.text:c?.type==='image'?'[ảnh]':'').filter(Boolean).join('\n');
  return '';
}
function toolItem(block){
  const input=block.input&&typeof block.input==='object'?block.input:{};const id=block.id||null;
  if(block.name==='Bash'||block.name==='PowerShell')return {id,type:'command',command:head(input.command,1000),cwd:null,status:'inProgress',exitCode:null,output:'',durationMs:null};
  if(EDIT_TOOLS.has(block.name)){const p=input.file_path||input.notebook_path||'';return {id,type:'files',status:'inProgress',changes:p?[{path:String(p),kind:block.name==='Write'?'add':'update'}]:[]};}
  if(block.name==='WebSearch')return {id,type:'search',query:head(input.query||'',300)};
  if(block.name==='TodoWrite'&&Array.isArray(input.todos))return {id,type:'plan',text:head(input.todos.map(t=>(t.status==='completed'?'✓ ':t.status==='in_progress'?'▸ ':'○ ')+(t.content||'')).join('\n'),4000)};
  const detail=input.file_path||input.pattern||input.url||input.description||input.path||'';
  return {id,type:'tool',name:block.name+(detail?' · '+head(String(detail),160):''),status:'inProgress'};
}
function finishTool(item,block){
  const out=resultText(block.content),failed=block.is_error===true;
  if(item.type==='command'){item.output=tail(out,2000);item.exitCode=failed?1:0;item.status=failed?'failed':'completed';}
  else if(item.type==='files'||item.type==='tool')item.status=failed?'failed':'completed';
}
// Assistant text blocks of one API message may be split over several transcript
// entries; numbering them per message id keeps live and stored ids identical.
class ItemIds{constructor(){this.counts=new Map();}text(messageId){const n=this.counts.get(messageId)||0;this.counts.set(messageId,n+1);return `${messageId}:t${n}`;}}
function buildTurns(messages,{active=false}={}){
  const turns=[],tools=new Map(),ids=new ItemIds();let turn=null;
  const open=(id,at)=>{turn={id,status:'completed',error:null,startedAt:at,completedAt:null,durationMs:null,items:[]};turns.push(turn);};
  for(const m of messages||[]){
    const msg=m?.message;if(!msg||m.parent_tool_use_id)continue;
    if(m.type==='user'){
      const list=blocks(msg.content);
      for(const b of list)if(b?.type==='tool_result'){const item=tools.get(b.tool_use_id);if(item)finishTool(item,b);}
      const text=cleanPrompt(list.filter(b=>b?.type==='text').map(b=>b.text).join('\n'));
      const attachments=list.filter(b=>b?.type==='image'||b?.type==='document').length;
      if(text||attachments){open(m.uuid,null);turn.items.push({id:m.uuid,type:'user',text:head(text,8000),attachments});}
    }else if(m.type==='assistant'){
      if(!turn)open(m.uuid,null);
      for(const b of blocks(msg.content)){
        if(b?.type==='text'&&b.text?.trim())turn.items.push({id:ids.text(msg.id||m.uuid),type:'agent',text:head(b.text,20000)});
        else if(b?.type==='tool_use'){const item=toolItem(b);tools.set(b.id,item);turn.items.push(item);}
      }
    }
  }
  // A tool that never got a result was interrupted, unless the session is still running.
  const last=turns[turns.length-1];
  for(const item of tools.values())if(item.status==='inProgress'&&!(active&&last?.items.includes(item)))item.status='interrupted';
  if(active&&last)last.status='inProgress';
  return turns;
}
module.exports={buildTurns,toolItem,finishTool,cleanPrompt,ItemIds,resultText,EDIT_TOOLS};
