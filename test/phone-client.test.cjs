'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {sign}=require('../src/remote/phone-server.cjs');
const root=path.join(__dirname,'../src/remote/static');
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
const key='new-qr-key-'+'n'.repeat(32),oldKey='old-qr-key-'+'o'.repeat(32);
function browser(t,{hash='#k='+key,entries={},writeFails=false,respond=null}={}){
  const w=new JSDOM(fs.readFileSync(path.join(root,'phone.html'),'utf8'),{url:'http://192.168.1.23:47860/?pair=fixture'+hash,runScripts:'outside-only',pretendToBeVisual:true}).window;
  const values=new Map(Object.entries(entries)),requests=[],sources=[],errors=[];
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>{if(writeFails)throw Error('Storage unavailable');values.set(k,v);},removeItem:k=>{if(!writeFails)values.delete(k);}}});
  w.scrollTo=()=>{};w.addEventListener('error',e=>errors.push(e.message));
  class Source{
    static CLOSED=2;
    constructor(url){this.url=url;this.readyState=0;this.listeners=new Map();sources.push(this);}
    addEventListener(name,fn){this.listeners.set(name,fn);}
    emit(name,value){this.listeners.get(name)?.({data:JSON.stringify(value)});}
    open(){this.readyState=1;this.onopen?.({});}
    close(){this.readyState=2;}
  }
  w.EventSource=Source;
  w.fetch=async(url,options)=>{
    const body=JSON.parse(options.body),request={url,options,body};requests.push(request);
    if(respond){const custom=await respond(request);if(custom)return custom;}
    return {ok:true,status:200,json:async()=>({ok:true,result:body.cmd==='threads'?{threads:[],nextCursor:null,notices:[]}:body.cmd==='heartbeat'?{connected:true}:{version:'fixture'}})};
  };
  w.eval(fs.readFileSync(path.join(root,'sha256.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'phone.js'),'utf8'));
  t.after(()=>{w.close();assert.deepEqual(errors,[],'the phone page must not throw');});
  return {w,values,requests,sources};
}

test('a newly scanned QR wins over stale storage even when storage writes fail, and survives a reload',async t=>{
  const initial={'pad-pairing':JSON.stringify({secret:oldKey,device:'device-old-browser'}),'pad-secret':oldKey,'pad-device':'device-old-browser'};
  const first=browser(t,{entries:initial,writeFails:true});await settle();
  const hello=first.requests.find(r=>r.body.cmd==='hello');assert(hello);
  assert.equal(hello.options.headers['X-Pad-Signature'],sign(key,'POST\n/api/call\n'+hello.options.body));
  const fragment=new URLSearchParams(first.w.location.hash.slice(1));assert.equal(fragment.get('k'),key);assert.equal(fragment.get('d'),hello.body.d);
  const reloaded=browser(t,{hash:first.w.location.hash,entries:initial,writeFails:true});await settle();
  assert.equal(reloaded.requests.find(r=>r.body.cmd==='hello').body.d,hello.body.d,'a private browser must not invent a new device on every reload');
  assert.equal(first.sources.length,1);assert.equal(reloaded.sources.length,1);
});

test('the phone acknowledges heartbeats and sends a connection-scoped keepalive disconnect on pagehide',async t=>{
  const {w,sources,requests}=browser(t);await settle();const source=sources[0],id=new URL(source.url,w.location.origin).searchParams.get('c');
  source.open();source.emit('heartbeat',{connectionId:id});await settle();
  assert.equal(requests.find(r=>r.body.cmd==='heartbeat').body.args.connectionId,id);
  w.dispatchEvent(new w.Event('pagehide'));await settle();
  const disconnect=requests.find(r=>r.body.cmd==='disconnect');assert.equal(disconnect.body.args.connectionId,id);assert.equal(disconnect.options.keepalive,true);assert.equal(source.readyState,2);
  w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();
  assert.equal(sources.length,2);assert.notEqual(new URL(sources[1].url,w.location.origin).searchParams.get('c'),id,'restoring the same page starts a new stream lease');
});

test('a new QR in the same tab ignores a late authentication failure and a kicked event from its old connection',async t=>{
  let release;
  const {w,sources,requests,values}=browser(t,{hash:'#k='+oldKey,respond:request=>request.body.cmd==='claudeUsage'?new Promise(r=>release=r):null});await settle();
  const old=sources[0];old.open();w.document.querySelector('#refresh-claude').click();await settle();assert(release);
  w.location.hash='k='+key;await new Promise(r=>setTimeout(r,10));await settle();
  assert.equal(sources.length,2);
  release({ok:false,status:403,json:async()=>({error:'Old key was revoked'})});old.emit('kicked',{});await settle();
  assert.equal(JSON.parse(values.get('pad-pairing')).secret,key);
  assert(w.document.querySelector('#pair-screen').classList.contains('hidden'));
  const latestHello=requests.filter(r=>r.body.cmd==='hello').at(-1);
  assert.equal(latestHello.options.headers['X-Pad-Signature'],sign(key,'POST\n/api/call\n'+latestHello.options.body));
});

test('a new scan in another tab suspends the old tab instead of reloading it and stealing pairing back',async t=>{
  const {w,sources,requests,values}=browser(t,{hash:'#k='+oldKey});await settle();const count=requests.length;
  const next=JSON.stringify({secret:key,device:'device-new-scanner'});values.set('pad-pairing',next);
  w.dispatchEvent(new w.StorageEvent('storage',{key:'pad-pairing',newValue:next}));await settle();
  assert.equal(sources[0].readyState,2);assert(!w.document.querySelector('#pair-screen').classList.contains('hidden'));
  assert(w.document.querySelector('#pair-message').textContent.includes('tab vừa quét mã'));
  w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();
  assert.equal(sources.length,1);assert.equal(requests.slice(count).filter(r=>r.body.cmd==='hello').length,0);
  assert.equal(values.get('pad-pairing'),next);
});
