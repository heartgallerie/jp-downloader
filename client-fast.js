(()=>{
const $=id=>document.getElementById(id);
const form=$('f'),input=$('u'),convert=$('b'),panel=$('panel'),title=$('title'),filename=$('filename'),cancel=$('cancel'),actions=$('actions'),videoWrap=$('videoWrap'),video=$('video'),error=$('error'),stage=$('stage'),stageText=$('stageText'),bar=$('bar'),percent=$('percent'),time=$('time'),editName=$('editName');
if(!form||!input||!convert)return;
let jobId=null,objectUrl=null,cancelled=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const setStatus=(s,p)=>{title.textContent=s;stageText.textContent=s;bar.style.width=`${Math.max(0,Math.min(100,p||0))}%`;percent.textContent=`${Math.round(p||0)}%`;time.textContent=p?`${Math.round(p)}%`:'Preparing…'};
const baseName=u=>{try{return(decodeURIComponent(new URL(u).pathname.split('/').pop()||'video').replace(/\.[^.]+$/,'').replace(/[^\w\- ]+/g,' ').trim()||'video')}catch{return'video'}};
async function json(url,options){const r=await fetch(url,options);let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d}
async function getJob(){return json(`/api/jobs/${jobId}`)}
async function getSource(){return json(`/api/jobs/${jobId}/source`)}
function parsePlaylist(text,base){const lines=text.replace(/\r/g,'').split('\n'),segments=[];for(let i=0;i<lines.length;i++){const x=lines[i].trim();if(!x||x.startsWith('#'))continue;try{segments.push({line:i,url:new URL(x,base).href})}catch{}}if(!segments.length)throw Error('No video segments found in playlist.');return{lines,segments}}
async function mediaFetch(url,headers={}){
  try{
    const r=await fetch(url,{cache:'no-store'});
    if(r.ok)return r;
  }catch{}
  const q=`/api/media?url=${encodeURIComponent(url)}`;
  const r=await fetch(q,{cache:'no-store'});
  if(!r.ok)throw Error(`Media request failed (HTTP ${r.status}).`);
  return r;
}
async function loadFFmpeg(){
  setStatus('Loading local converter…',3);
  if(window.__jpFF)return window.__jpFF;
  const m=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js');
  const u=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js');
  const ff=new m.FFmpeg();
  ff.on('progress',({progress:p})=>setStatus('Converting on your PC…',70+Math.min(30,p*30)));
  await ff.load({coreURL:await u.toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js','text/javascript'),wasmURL:await u.toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm','application/wasm')});
  window.__jpFF=ff;return ff;
}
async function run(e){
  if(e){e.preventDefault();e.stopPropagation();}
  cancelled=false;panel.classList.remove('hidden');actions.classList.add('hidden');actions.innerHTML='';error.classList.add('hidden');videoWrap.classList.add('hidden');video.removeAttribute('src');convert.disabled=true;cancel.disabled=false;
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null}
  const watch=input.value.trim();
  try{
    if(!watch)throw Error('Paste a watch URL first.');
    localStorage.setItem('jpDownloaderLastUrl',watch);
    const d=await json('/api/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:watch})});
    jobId=d.jobId;
    for(;;){if(cancelled)throw Error('Cancelled.');const j=await getJob();setStatus(j.status,Math.min(15,j.progress||0));if(j.sourceReady)break;if(j.error)throw Error(j.error);await wait(500)}
    const src=await getSource();setStatus('Preparing stream…',18);
    const pr=await mediaFetch(src.url,src.headers||{});
    const p=parsePlaylist(await pr.text(),src.url),ff=await loadFFmpeg(),local=p.lines.slice();
    let next=0,done=0;const concurrency=6;
    async function worker(){for(;;){if(cancelled)throw Error('Cancelled.');const n=next++;if(n>=p.segments.length)return;const s=p.segments[n];const rr=await mediaFetch(s.url,src.headers||{});const data=new Uint8Array(await rr.arrayBuffer());const ext=(new URL(s.url).pathname.match(/\.([A-Za-z0-9]+)$/)?.[1]||'bin').toLowerCase();const name=`seg_${String(n).padStart(6,'0')}.${ext}`;await ff.writeFile(name,data);local[s.line]=name;done++;setStatus(`Downloading segments… ${done}/${p.segments.length}`,20+45*done/p.segments.length)}}
    await Promise.all(Array.from({length:Math.min(concurrency,p.segments.length)},worker));
    await ff.writeFile('input.m3u8',new TextEncoder().encode(local.join('\n')));
    setStatus('Converting on your PC…',68);
    await ff.exec(['-allowed_extensions','ALL','-i','input.m3u8','-c:v','libx264','-preset','ultrafast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart','output.mp4']);
    const bytes=await ff.readFile('output.mp4');objectUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
    filename.value=baseName(watch)+'.mp4';filename.disabled=false;actions.classList.remove('hidden');
    const a=document.createElement('a');a.className='action primary';a.textContent='Download MP4';a.href=objectUrl;a.download=filename.value;actions.append(a);
    video.src=objectUrl;videoWrap.classList.remove('hidden');setStatus('Ready — MP4 created on your PC.',100);stage.classList.add('hidden');
  }catch(err){if(err.message!=='Cancelled'){error.textContent=err.message||'Conversion failed.';error.classList.remove('hidden')}setStatus(err.message==='Cancelled'?'Cancelled':'Conversion failed.',0)}
  finally{convert.disabled=false;cancel.disabled=true}
}

// Replace the old inline form handler instead of competing with it.
form.onsubmit=run;
cancel.onclick=e=>{e.preventDefault();cancelled=true;cancel.disabled=true;cancel.textContent='Cancelling…';if(jobId)fetch(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{})};
if(editName)editName.onclick=()=>{filename.disabled=false;filename.focus();filename.select()};
try{const last=localStorage.getItem('jpDownloaderLastUrl');if(last&&!input.value)input.value=last}catch{}
})();
