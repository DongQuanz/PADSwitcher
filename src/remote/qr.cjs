'use strict';
// QR code, byte mode, error correction level M, versions 1-20. Dependency-free encoder
// (ISO/IEC 18004, after Project Nayuki's reference design).
const ECC_PER_BLOCK=[-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26];
const NUM_BLOCKS=[-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16];
const FORMAT_ECL_M=0;
function gfMul(x,y){let z=0;for(let i=7;i>=0;i--){z=((z<<1)^((z>>>7)*0x11D))&0xFF;z^=((y>>>i)&1)*x;}return z;}
function rsDivisor(degree){
  const res=new Array(degree-1).fill(0).concat([1]);let root=1;
  for(let n=0;n<degree;n++){for(let j=0;j<degree;j++){res[j]=gfMul(res[j],root);if(j+1<degree)res[j]^=res[j+1];}root=gfMul(root,2);}
  return res;
}
function rsRemainder(data,divisor){
  const res=new Array(divisor.length).fill(0);
  for(const b of data){const factor=b^res.shift();res.push(0);divisor.forEach((coef,i)=>{res[i]^=gfMul(coef,factor);});}
  return res;
}
function rawModules(ver){let r=(16*ver+128)*ver+64;if(ver>=2){const na=Math.floor(ver/7)+2;r-=(25*na-10)*na-55;if(ver>=7)r-=36;}return r;}
const dataCodewords=ver=>Math.floor(rawModules(ver)/8)-ECC_PER_BLOCK[ver]*NUM_BLOCKS[ver];
function alignPositions(ver,size){
  if(ver===1)return [];
  const na=Math.floor(ver/7)+2,step=Math.floor((ver*8+na*3+5)/(na*4-4))*2,out=[];
  for(let i=0;i<na-1;i++)out.push(size-7-i*step);
  return out.concat([6]).reverse();
}
const MASKS=[
  (x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,
  (x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,
  (x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0,
];
class Grid{
  constructor(ver){this.ver=ver;this.size=ver*4+17;this.m=Array.from({length:this.size},()=>new Array(this.size).fill(false));this.fn=Array.from({length:this.size},()=>new Array(this.size).fill(false));}
  setf(x,y,dark){this.m[y][x]=dark;this.fn[y][x]=true;}
  functionPatterns(){
    const s=this.size;
    for(let i=0;i<s;i++){this.setf(6,i,i%2===0);this.setf(i,6,i%2===0);}
    for(const [cx,cy]of [[3,3],[s-4,3],[3,s-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const x=cx+dx,y=cy+dy,d=Math.max(Math.abs(dx),Math.abs(dy));if(x>=0&&x<s&&y>=0&&y<s)this.setf(x,y,d!==2&&d!==4);}
    const al=alignPositions(this.ver,s),n=al.length;
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      if((i===0&&j===0)||(i===0&&j===n-1)||(i===n-1&&j===0))continue;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)this.setf(al[i]+dx,al[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
    }
    this.formatBits(0);
    if(this.ver>=7){
      let rem=this.ver;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1F25);
      const bits=this.ver<<12|rem;
      for(let i=0;i<18;i++){const bit=((bits>>>i)&1)===1,a=s-11+i%3,b=Math.floor(i/3);this.setf(a,b,bit);this.setf(b,a,bit);}
    }
  }
  formatBits(mask){
    const data=FORMAT_ECL_M<<3|mask;let rem=data;
    for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
    const bits=(data<<10|rem)^0x5412,g=i=>((bits>>>i)&1)===1,s=this.size;
    for(let i=0;i<6;i++)this.setf(8,i,g(i));
    this.setf(8,7,g(6));this.setf(8,8,g(7));this.setf(7,8,g(8));
    for(let i=9;i<15;i++)this.setf(14-i,8,g(i));
    for(let i=0;i<8;i++)this.setf(s-1-i,8,g(i));
    for(let i=8;i<15;i++)this.setf(8,s-15+i,g(i));
    this.setf(8,s-8,true);
  }
  codewords(data){
    const s=this.size;let i=0;
    for(let right=s-1;right>=1;right-=2){
      if(right===6)right=5;
      for(let vert=0;vert<s;vert++)for(let j=0;j<2;j++){
        const x=right-j,up=((right+1)&2)===0,y=up?s-1-vert:vert;
        if(!this.fn[y][x]&&i<data.length*8){this.m[y][x]=((data[i>>>3]>>>(7-(i&7)))&1)===1;i++;}
      }
    }
  }
  applyMask(mask){const f=MASKS[mask];for(let y=0;y<this.size;y++)for(let x=0;x<this.size;x++)if(!this.fn[y][x]&&f(x,y))this.m[y][x]=!this.m[y][x];}
  penalty(){
    const s=this.size,m=this.m,cols=m[0].map((_,x)=>m.map(r=>r[x]));let p=0;
    for(const rows of [m,cols])for(const row of rows){
      let run=0,last=null;
      for(const v of row){if(v===last)run++;else{if(run>=5)p+=run-2;run=1;last=v;}}
      if(run>=5)p+=run-2;
    }
    for(let y=0;y<s-1;y++)for(let x=0;x<s-1;x++)if(m[y][x]===m[y][x+1]&&m[y][x]===m[y+1][x]&&m[y][x]===m[y+1][x+1])p+=3;
    // Finder-like runs (1:1:3:1:1 with four light modules) confuse scanners.
    for(const rows of [m,cols])for(const row of rows){
      const line='0000'+row.map(v=>v?'1':'0').join('')+'0000';
      for(const pat of ['10111010000','00001011101']){let i=line.indexOf(pat);while(i!==-1){p+=40;i=line.indexOf(pat,i+1);}}
    }
    const dark=m.reduce((n,r)=>n+r.filter(Boolean).length,0),total=s*s;
    p+=Math.floor((Math.abs(dark*20-total*10)+total-1)/total)*10;
    return p;
  }
}
function encode(text){
  const data=Buffer.from(String(text),'utf8');let ver,cap,ccBits;
  for(ver=1;ver<ECC_PER_BLOCK.length;ver++){cap=dataCodewords(ver);ccBits=ver<=9?8:16;if(4+ccBits+data.length*8<=cap*8)break;}
  if(ver>=ECC_PER_BLOCK.length)throw new RangeError('Text is too long for a QR code.');
  const bits=[],put=(val,n)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1);};
  put(0b0100,4);put(data.length,ccBits);for(const b of data)put(b,8);
  put(0,Math.min(4,cap*8-bits.length));put(0,(8-bits.length%8)%8);
  for(let pad=0xEC;bits.length<cap*8;pad^=0xEC^0x11)put(pad,8);
  const dcw=[];for(let i=0;i<bits.length;i+=8)dcw.push(parseInt(bits.slice(i,i+8).join(''),2));
  const nb=NUM_BLOCKS[ver],ecl=ECC_PER_BLOCK[ver],raw=Math.floor(rawModules(ver)/8),nShort=nb-raw%nb,shortLen=Math.floor(raw/nb),div=rsDivisor(ecl),blocks=[];
  for(let i=0,k=0;i<nb;i++){
    const d=dcw.slice(k,k+shortLen-ecl+(i<nShort?0:1));k+=d.length;
    const e=rsRemainder(d,div);if(i<nShort)d.push(0);blocks.push(d.concat(e));
  }
  const final=[];
  for(let i=0;i<blocks[0].length;i++)blocks.forEach((blk,j)=>{if(i!==shortLen-ecl||j>=nShort)final.push(blk[i]);});
  let best=null,bestP=Infinity;
  for(let mask=0;mask<8;mask++){
    const g=new Grid(ver);g.functionPatterns();g.codewords(final);g.applyMask(mask);g.formatBits(mask);
    const p=g.penalty();if(p<bestP){best=g;bestP=p;}
  }
  return best.m;
}
function toSvg(modules,quiet=4){
  const s=modules.length,n=s+2*quiet;let d='';
  for(let y=0;y<s;y++)for(let x=0;x<s;x++)if(modules[y][x])d+=`M${x+quiet},${y+quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
module.exports={encode,toSvg};
