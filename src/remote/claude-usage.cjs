'use strict';
// Claude plan usage from three sources, newest wins:
//  - a status line PADSwitcher installs in Claude Code (documented, written whenever Claude Code runs),
//  - rate-limit events of turns started from the phone,
//  - the SDK's on-demand usage read (experimental, used for the refresh button).
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {modify,applyEdits,parse}=require('jsonc-parser');
const {atomicWrite}=require('../core/files.cjs');
const {UserError}=require('../core/errors.cjs');

const KINDS=['five_hour','seven_day','seven_day_opus','seven_day_sonnet'];
const seconds=value=>{if(value==null||value==='')return null;if(typeof value==='number')return value>1e12?Math.floor(value/1000):Math.floor(value);const t=Date.parse(value);return Number.isFinite(t)?Math.floor(t/1000):null;};
const percent=value=>Number.isFinite(Number(value))?Math.max(0,Math.min(100,Number(value))):null;
// Written in ASCII with forward slashes: Claude Code may run it through Git Bash.
function script(file){
  const target=file.replace(/\\/g,'/').replace(/'/g,"''");
  return [
    '# PADSwitcher: records Claude plan usage for the phone remote, then prints a short status line.',
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    '$raw = [Console]::In.ReadToEnd()',
    'try { $d = $raw | ConvertFrom-Json } catch { exit 0 }',
    'if ($d.rate_limits) {',
    `  $file = '${target}'`,
    '  $dir = Split-Path -Parent $file',
    '  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }',
    '  $json = @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); rate_limits = $d.rate_limits } | ConvertTo-Json -Depth 6 -Compress',
    '  $tmp = $file + \'.tmp\'',
    '  try { [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false)); Move-Item -Force -LiteralPath $tmp -Destination $file } catch {}',
    '}',
    '$parts = @()',
    'if ($d.model.display_name) { $parts += $d.model.display_name }',
    '$f = $d.rate_limits.five_hour.used_percentage',
    'if ($null -ne $f) { $parts += (\'5h {0:N0}%\' -f $f) }',
    '$w = $d.rate_limits.seven_day.used_percentage',
    'if ($null -ne $w) { $parts += (\'7d {0:N0}%\' -f $w) }',
    'Write-Output ($parts -join \' | \')',
    '',
  ].join('\r\n');
}
class ClaudeUsage{
  constructor({root,home=os.homedir(),now=()=>Date.now()}){
    this.dir=path.join(root,'claude');this.file=path.join(this.dir,'usage.json');this.scriptFile=path.join(this.dir,'statusline.ps1');
    this.settingsFile=path.join(home,'.claude','settings.json');this.now=now;this.latest=null;this.setup='unknown';
  }
  get command(){
    // Claude Code runs status commands through a shell, including Git Bash on Windows.
    const file=this.scriptFile.replace(/\\/g,'/').replace(/'/g,"'\"'\"'");
    return "powershell -NoProfile -ExecutionPolicy Bypass -File '"+file+"'";
  }
  // ---------- sources ----------
  fromStatusLine(data){
    const r=data?.rate_limits;if(!r||typeof r!=='object')return null;
    const windows=KINDS.filter(k=>r[k]&&percent(r[k].used_percentage)!=null).map(k=>({kind:k,usedPercent:percent(r[k].used_percentage),resetsAt:seconds(r[k].resets_at)}));
    return windows.length?{source:'statusline',at:(seconds(data.at)||0)*1000,plan:null,windows}:null;
  }
  fromUsage(response){
    const r=response?.rate_limits;if(!response?.rate_limits_available||!r)return null;
    const windows=KINDS.filter(k=>r[k]&&percent(r[k].utilization)!=null).map(k=>({kind:k,usedPercent:percent(r[k].utilization),resetsAt:seconds(r[k].resets_at)}));
    if(!windows.length)return null;
    return this.latest={source:'claude',at:this.now(),plan:response.subscription_type||null,windows};
  }
  // Rate-limit events carry one window at a time, with utilization as a fraction.
  fromEvent(info){
    if(!info?.rateLimitType||!KINDS.includes(info.rateLimitType)||info.utilization==null)return this.latest;
    const value=Number(info.utilization),used=percent(value<=1?value*100:value);if(used==null)return this.latest;
    const base=this.latest||{source:'session',at:0,plan:null,windows:[]};
    const windows=base.windows.filter(w=>w.kind!==info.rateLimitType).concat({kind:info.rateLimitType,usedPercent:used,resetsAt:seconds(info.resetsAt)});
    windows.sort((a,b)=>KINDS.indexOf(a.kind)-KINDS.indexOf(b.kind));
    return this.latest={...base,source:'session',at:this.now(),windows};
  }
  async read(){
    let fromFile=null;
    try{fromFile=this.fromStatusLine(JSON.parse((await fs.readFile(this.file,'utf8')).replace(/^﻿/,'')));}catch{}
    const best=[fromFile,this.latest].filter(Boolean).sort((a,b)=>b.at-a.at)[0]||null;
    if(!best)return null;
    // A window past its reset time no longer describes the current period.
    const now=Math.floor(this.now()/1000);
    return {...best,windows:best.windows.map(w=>w.resetsAt&&w.resetsAt<=now?{...w,usedPercent:0,expired:true}:w)};
  }
  // ---------- status line setup in ~/.claude/settings.json ----------
  async settings(){
    try{const text=await fs.readFile(this.settingsFile,'utf8');return {text,data:parse(text)||{}};}
    catch(e){if(e.code==='ENOENT')return {text:'{}\n',data:{}};throw e;}
  }
  async status(){
    try{
      const {data}=await this.settings(),command=data.statusLine?.command;
      const legacy='powershell -NoProfile -ExecutionPolicy Bypass -File '+this.scriptFile.replace(/\\/g,'/');
      const ours=data.statusLine?.type==='command'&&typeof command==='string'&&[this.command,legacy].includes(command.replace(/\\/g,'/'));
      return this.setup=!data.statusLine?'missing':ours?'installed':'foreign';
    }catch{return this.setup='unknown';}
  }
  async install(){
    const {text,data}=await this.settings();
    if(data.statusLine&&await this.status()==='foreign')throw new UserError('Claude Code đã có status line khác. Gỡ nó trong ~/.claude/settings.json trước nếu muốn PADSwitcher đọc quota theo cách này.','CLAUDE_STATUSLINE_FOREIGN');
    await fs.mkdir(this.dir,{recursive:true});
    await atomicWrite(this.scriptFile,'﻿'+script(this.file));
    await fs.mkdir(path.dirname(this.settingsFile),{recursive:true});
    const edits=modify(text,['statusLine'],{type:'command',command:this.command},{formattingOptions:{insertSpaces:true,tabSize:2}});
    await atomicWrite(this.settingsFile,applyEdits(text,edits));
    return this.status();
  }
  async remove(){
    if(await this.status()!=='installed')return this.setup;
    const {text}=await this.settings();
    await atomicWrite(this.settingsFile,applyEdits(text,modify(text,['statusLine'],undefined,{formattingOptions:{insertSpaces:true,tabSize:2}})));
    return this.status();
  }
}
module.exports={ClaudeUsage,script};
