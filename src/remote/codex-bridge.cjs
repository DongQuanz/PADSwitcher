'use strict';
// The phone remote's own client of the shared gateway. It attaches like any IDE, so
// phone turns pass through the same router, quota rotation and turn tracking.
const {EventEmitter}=require('node:events');
const WebSocket=require('ws');
const {connect}=require('../core/ws-rpc.cjs');
const {UserError}=require('../core/errors.cjs');
// Server requests the phone can answer. Others stay for the desktop client to handle.
const APPROVALS={
  'item/commandExecution/requestApproval':new Set(['accept','acceptForSession','decline','cancel']),
  'item/fileChange/requestApproval':new Set(['accept','acceptForSession','decline','cancel']),
};
class CodexBridge extends EventEmitter{
  constructor(gateway,{version='0'}={}){
    super();this.gateway=gateway;this.version=version;this.socket=null;this.flight=null;this.sequence=0;this.pending=new Map();
    this.requests=new Map();this.subscribed=new Set();
  }
  get connected(){return this.socket?.readyState===WebSocket.OPEN;}
  ensure(){
    if(this.connected)return Promise.resolve();
    if(this.flight)return this.flight;
    const shared=this.gateway?.shared;
    if(!shared||shared.status!=='ready'||!shared.url||!shared.frontToken)return Promise.reject(new UserError('Kết nối Codex chưa bật trên máy tính.','PHONE_GATEWAY_STOPPED'));
    this.flight=(async()=>{
      const socket=await connect(shared.url,shared.frontToken,3000);
      this.socket=socket;
      socket.on('message',data=>this.receive(data));
      socket.on('close',()=>{if(this.socket!==socket)return;this.socket=null;this.subscribed.clear();
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new UserError('Mất kết nối với Codex.','PHONE_GATEWAY_CLOSED'));}
        this.pending.clear();for(const id of this.requests.keys())this.emit('resolved',id);this.requests.clear();this.emit('closed');});
      await this.send('initialize',{clientInfo:{name:'padswitcher_phone',title:'PADSwitcher Phone',version:this.version},capabilities:{experimentalApi:true}},10000);
      this.raw({method:'initialized',params:{}});
    })().catch(error=>{this.socket?.terminate();this.socket=null;throw error;}).finally(()=>{this.flight=null;});
    return this.flight;
  }
  raw(message){if(this.connected)this.socket.send(JSON.stringify(message));}
  send(method,params={},timeout=30000){
    if(!this.connected)return Promise.reject(new UserError('Mất kết nối với Codex.','PHONE_GATEWAY_CLOSED'));
    const id='phone-'+(++this.sequence);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new UserError('Codex phản hồi quá lâu.','PHONE_GATEWAY_TIMEOUT'));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.raw({id,method,params});
    });
  }
  async request(method,params,timeout){await this.ensure();return this.send(method,params,timeout);}
  receive(data){
    let m;try{m=JSON.parse(data.toString());}catch{return;}
    if(!m||typeof m!=='object')return;
    if(m.id!=null&&!m.method){
      const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
      // Codex's own message is shown on the phone; it never contains credentials.
      if(m.error)p.reject(new UserError(String(m.error.message||'Codex chưa thực hiện được yêu cầu.').slice(0,300),'PHONE_CODEX'));else p.resolve(m.result);
      return;
    }
    if(m.method&&m.id!=null){
      const request={id:m.id,method:m.method,params:m.params||{},at:Date.now(),answerable:Object.hasOwn(APPROVALS,m.method)};
      this.requests.set(String(m.id),request);this.emit('request',request);return;
    }
    if(m.method==='serverRequest/resolved'){const id=String(m.params?.requestId);if(this.requests.delete(id))this.emit('resolved',id);}
    if(m.method)this.emit('notification',m.method,m.params||{});
  }
  answer(requestId,decision){
    const request=this.requests.get(String(requestId));
    if(!request)throw new UserError('Yêu cầu duyệt này đã được xử lý hoặc không còn.','PHONE_APPROVAL_GONE');
    const allowed=Object.hasOwn(APPROVALS,request.method)&&APPROVALS[request.method];
    if(!allowed||!allowed.has(decision))throw new UserError('Lựa chọn duyệt không hợp lệ.','PHONE_APPROVAL_INVALID');
    this.raw({id:request.id,result:{decision}});this.requests.delete(String(requestId));this.emit('resolved',String(requestId));
  }
  // Rejoins a loaded thread or loads it from disk, so its live events reach this client.
  async subscribe(threadId){
    if(this.subscribed.has(threadId)&&this.connected)return;
    await this.request('thread/resume',{threadId,excludeTurns:true});this.subscribed.add(threadId);
  }
  // The close handler rejects pending calls and clears subscriptions.
  close(){this.socket?.terminate();}
}
module.exports={CodexBridge,APPROVALS};
