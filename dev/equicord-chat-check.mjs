// Browser fixture for the shipped Equicord attachment module. No real CDN/socket/account.
import { bindMessage } from '/message.mjs';
import { attachmentSource, readCarrier } from '/attachment.mjs';
export async function checkChat(file, carrier, ok) {
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const wait = async predicate => { for (let i=0;i<90;i++){if(predicate())return;await pause(30);}throw Error('timeout waiting for fixture: '+predicate); };
    const bytes = new Uint8Array(await carrier.arrayBuffer());
    const a = { id:'200', filename:'test.png', size:bytes.length, url:'https://cdn.discordapp.com/attachments/100/200/test.png?hm=fixture' };
    const msg = { id:'300',channel_id:'100', attachments:[a] };
    ok(!!attachmentSource(a,'100') && !attachmentSource({...a,spoiler:true},'100') && !attachmentSource({...a,filename:'SPOILER_test.png'},'100') && !attachmentSource({...a, flags:1},'100') && !attachmentSource(a,'101') && !attachmentSource({...a,url:a.url.replace('cdn.discordapp.com','cdn.discordapp.com.invalid')},'100'), 'chat:attachment-boundary');
    const oldFetch = window.fetch, local = URL.createObjectURL(carrier); const log=[];
    let release; const gate = new Promise(r => { release=r; });
    let rangeAttempts=0;
    window.fetch=async (url,init) => {
        if(String(url)!==a.url) return oldFetch(url,init);
        if(init.credentials!=='omit' || init.referrerPolicy!=='no-referrer' || init.redirect!=='error')throw Error('request policy');
        if(init.headers?.Range) { if(++rangeAttempts===1){log.push('503');return new Response(null,{status:503});} log.push('range'); return new Response(bytes.slice(0,128),{status:206}); }
        log.push('full'); await gate; return new Response(bytes);
    };
    const scroll = document.createElement('div'); scroll.style.cssText='height:160px;width:300px;overflow-y:scroll';
    const spacer=document.createElement('div');spacer.style.height='900px';scroll.append(spacer);
    const row=document.createElement('div');row.id='chat-messages-100-300';row.style.cssText='position:relative;padding-left:50px';scroll.append(row);
    const anchor=document.createElement('a');anchor.href=a.url;
    const img=new Image();img.width=156;img.height=110;img.src=local;anchor.append(img);row.append(anchor);
    const marker=document.createElement('span');marker.hidden=true;row.append(marker);
    const next=document.createElement('div');next.textContent='next';scroll.append(next);document.body.append(scroll);await img.decode();
    let off=()=>{};try{
        off=bindMessage(marker,msg,'group'); await pause(150);ok(!log.length&&!row.querySelector('[data-moe-decoded]'),'chat:outside-two-screens');
        scroll.scrollTop=scroll.scrollHeight;await wait(()=>log.includes('503'));
        await pause(150);ok(log.join(',')==='503'&&!row.querySelector('[data-moe-decoded]'),'chat:503-no-spin-no-badge');
        scroll.scrollTop=0;await pause(180);scroll.scrollTop=scroll.scrollHeight;await wait(()=>log.includes('full'));
        ok(log.join(',')==='503,range,full','chat:503-reentry-retries-once');
        const before=img.getBoundingClientRect(),y=next.getBoundingClientRect().top;
        ok(img.src===local && !row.querySelector('[data-moe-decoded]') && !img.style.backgroundImage,'chat:no-premature-badge');release();
        await wait(()=>row.querySelector('[data-moe-decoded]'));const label=row.querySelector('[data-moe-decoded]');
        ok(label.textContent==='已解码下载' && img.style.backgroundImage.includes('blob:') && img.style.objectPosition.includes('-100000px'),'chat:image-and-badge');
        const after=img.getBoundingClientRect();ok(['top','left','width','height'].every(k=>before[k]===after[k]) && y===next.getBoundingClientRect().top,'chat:zero-layout-delta');
        const shot=await oldFetch('/paint',{method:'POST',body:JSON.stringify({x:Math.floor(after.x),y:Math.floor(after.y),width:Math.round(after.width),height:Math.round(after.height)})});
        if(!shot.ok)throw Error('screen capture failed');const painted=await createImageBitmap(await shot.blob());try{
            const ctx=new OffscreenCanvas(painted.width,painted.height).getContext('2d');ctx.drawImage(painted,0,0);
            const matches=(x,y,rgb)=>{const px=ctx.getImageData(Math.floor(painted.width*x),Math.floor(painted.height*y),1,1).data;return rgb.every((v,i)=>Math.abs(px[i]-v)<=3);};
            ok(matches(.25,.4,[254,220,186])&&matches(.8,.75,[18,52,86]),'chat:decoded-pixels-on-screen');
        }finally{painted.close();}
        const dl=label.querySelector('a');const bmp=await createImageBitmap(await (await oldFetch(dl.href)).blob());const src=await createImageBitmap(file);try{ok(dl.download==='test-decoded.png'&&bmp.width===src.width&&bmp.height===src.height,'chat:decoded-download');}finally{src.close();bmp.close();}
        anchor.classList.add('spoilerHidden');await wait(()=>!row.querySelector('[data-moe-decoded]'));ok(img.src===local&&!img.style.backgroundImage,'chat:concealed-clears-paint');
        anchor.classList.remove('spoilerHidden');row.id='chat-messages-100-301';await pause(60);ok(!row.querySelector('[data-moe-decoded]')&&!img.style.objectPosition,'chat:row-reuse-no-stale-badge');
        let cancelled=false;const ordinary=new ReadableStream({pull(c){c.enqueue(new Uint8Array(128));},cancel(){cancelled=true;}});
        ok(await readCarrier(a.url,'group',new AbortController().signal,async()=>new Response(ordinary))===null && cancelled,'chat:normal-png-cancels-range-ignored');
        ok(log.join(',')==='503,range,full','chat:one-successful-range-one-full');
    }finally{release();off();scroll.remove();URL.revokeObjectURL(local);window.fetch=oldFetch;}
}
