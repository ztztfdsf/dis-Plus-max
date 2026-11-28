// Local browser I/O test. Usage: node dev/equicord-browser.mjs <chrome.exe> <evidence-parent>
// Uses a fresh profile and a loopback-only server. Never touches a Discord session.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const [exe, parent] = process.argv.slice(2);
if (!exe || !parent || !fs.existsSync(exe) || !fs.statSync(parent).isDirectory()) throw Error('expected Chrome path and existing evidence directory');
const dir = fs.mkdtempSync(path.join(parent, 'equi-io-'));
const media = fileURLToPath(new URL('../dist/equicord/moeGuard/',import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><script type="module">
import {encodeFile,decodeFile} from '/media.mjs';
import engine from '/engine.mjs';
import {checkChat} from '/chat-check.mjs';
const pass=[];const ok=(value,id)=>{if(!value)throw Error(id);pass.push(id);};
async function pixels(blob){const bmp=await createImageBitmap(blob);try{const c=new OffscreenCanvas(bmp.width,bmp.height);const ctx=c.getContext('2d');ctx.drawImage(bmp,0,0);return ctx.getImageData(0,0,c.width,c.height);}finally{bmp.close();}}
try{
 const c=new OffscreenCanvas(144,90), ctx=c.getContext('2d');ctx.fillStyle='#123456';ctx.fillRect(0,0,144,90);ctx.fillStyle='#fedcba';ctx.fillRect(27,13,18,49);
 for(const type of ['image/png','image/jpeg']){const raw=await c.convertToBlob({type});const file=new File([raw],'test.'+(type.endsWith('png')?'png':'jpg'),{type});const salt='group';const enc=await encodeFile(file,salt);const orig=await pixels(raw);const m=engine.pngReadMarker(new Uint8Array(await enc.slice(0,128).arrayBuffer()),salt);ok(enc.name==='test.png'&&enc.type==='image/png'&&m?.saltOk&&m.w===144&&m.h===90,type+':metadata');
 const restored=await pixels(await decodeFile(enc,salt));ok(orig.width===restored.width&&orig.height===restored.height&&restored.data.every((v,i)=>v===orig.data[i]),type+':all-pixels');
 let rejected=false;try{await decodeFile(enc,'other');}catch{rejected=true;}ok(rejected,type+':wrong-salt');
 rejected=false;try{await encodeFile(enc,salt);}catch{rejected=true;}ok(rejected,type+':no-double-encode');if(type==='image/png')await checkChat(file,enc,ok);}
 await fetch('/report',{method:'POST',body:JSON.stringify({pass})});
}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({pass,error:String(e)})});}
</script>`;
let capture;
let receive;const result=new Promise(r=>{receive=r;});
const server=http.createServer(async(req,res)=>{
    if(req.url==='/'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
    if(req.url==='/chat-check.mjs'&&req.method==='GET'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(new URL('./equicord-chat-check.mjs',import.meta.url)));}
    if(['/engine.mjs','/file-media.js','/media.mjs','/attachment.mjs','/message.mjs'].includes(req.url)&&req.method==='GET'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(media,req.url.slice(1))));}
    if(req.url==='/paint'&&req.method==='POST'){
        try{let s='';for await(const chunk of req){s+=chunk;if(s.length>256)throw Error('clip too large');}const {x,y,width,height}=JSON.parse(s);
            if(![x,y,width,height].every(Number.isInteger)||x<0||y<0||width<1||height<1||width>256||height>256)throw Error('bad clip');
            const png=await capture({x,y,width,height,scale:1});fs.writeFileSync(path.join(dir,'paint.png'),png);res.setHeader('Content-Type','image/png');return res.end(png);
        }catch{res.writeHead(500);return res.end('could not capture local fixture');}}
    if(req.url==='/report'&&req.method==='POST'){let s='';for await(const chunk of req){s+=chunk;if(s.length>8000){res.writeHead(413);return res.end();}}try{const obj=JSON.parse(s);res.end('ok');receive(obj);}catch{res.writeHead(400);res.end();}return;}
    res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(exe,['--headless=new','--remote-debugging-pipe','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--disable-breakpad','--disable-crash-reporter','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--user-data-dir='+path.join(dir,'profile'),'http://127.0.0.1:'+server.address().port+'/'],{stdio:['ignore','ignore','ignore','pipe','pipe'],env:{...process.env,TEMP:dir,TMP:dir,LOCALAPPDATA:dir,APPDATA:dir}});
child.stdio[3].on('error',()=>{});
const pending=new Map();let seq=1,wire='';child.stdio[4].setEncoding('utf8');child.stdio[4].on('data',chunk=>{
    wire+=chunk;let end;while((end=wire.indexOf('\0'))>=0){const p=JSON.parse(wire.slice(0,end));wire=wire.slice(end+1);const done=pending.get(p.id);if(done){pending.delete(p.id);p.error?done.reject(Error(p.error.message)):done.resolve(p.result);}}
});
function cdp(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');});}
capture=async clip=>{const {targetInfos}=await cdp('Target.getTargets');const target=targetInfos.find(t=>t.type==='page'&&t.url==='http://127.0.0.1:'+server.address().port+'/');if(!target)throw Error('no fixture page');
    const {sessionId}=await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true});try{const {data}=await cdp('Page.captureScreenshot',{format:'png',clip,fromSurface:true},sessionId);return Buffer.from(data,'base64');}finally{await cdp('Target.detachFromTarget',{sessionId});}};
const exited=new Promise(r=>{child.once('exit',(code)=>r({error:'Chrome exited '+code}));child.once('error',(e)=>r({error:e.message}));});
let timer;try{const report=await Promise.race([result,exited,new Promise(r=>{timer=setTimeout(()=>r({error:'test timed out'}),30000);})]);fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(path.join(dir,'report.json'),report);if(report.error||report.pass?.length!==21)process.exitCode=1;}finally{clearTimeout(timer);child.stdio[3].end(JSON.stringify({id:1,method:'Browser.close'})+'\0');server.close();server.closeAllConnections();}
