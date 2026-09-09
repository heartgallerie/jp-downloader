(()=>{
const $=id=>document.getElementById(id);
const form=$('convertForm'), input=$('urlInput'), convert=$('convertBtn'), cancel=$('cancelBtn'), download=$('downloadBtn'), video=$('videoPreview'), filename=$('filenameInput'), progress=$('progressBar'), status=$('statusText'), percent=$('progressPercent');
let jobId=null, objectUrl=null, cancelled=false;
const setStatus=(s,p)=>{if(status)status.textContent=s;if(progress)progress.style.width=`${Math.max(0,Math.min(100,p||0))}%`;if(percent)percent.textContent=`${Math.round(p||0)}%`;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function basename(u){try{return decodeURIComponent(new URL(u).pathname.split('/').pop()||'video').replace(/\.[^.]+$/,'').replace(/[^\w\- ]+/g,' ').trim()||'video'}catch{return'video'}}
async function getJob(){const r=await fetch(`/api/jobs/${jobId}`);if(!r.ok)throw new Error('Job status unavailable.');return r.json();}
async function getSource(){const r=await fetch(`/api/jobs/${jobId}/source`);if(!r.ok)throw new Error('Video source is not ready.');return r.json();}
function abs(base,x){try{return new URL(x,base).href}catch{return null}}
function parsePlaylist(text,base){
 const lines=text.replace(/\r/g,'').split('\n');
 const segs=[];
 for(let i=0;i<lines.length;i++){const t=lines[i].trim();if(!t||t.startsWith('#'))continue;const u=abs(base,t);if(u)segs.push({line:i,url:u});}
 if(!segs.length)throw new Error('No video segments found in playlist.');
 return {lines,segs};
}
async function loadFFmpeg(){
 setStatus('Loading local converter…',3);
 if(window.FFmpegWASM)return window.FFmpegWASM;
 const mod=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js');
 const util=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js');
 const ff=new mod.FFmpeg();
 ff.on('progress',({progress:p})=>setStatus('Converting on your PC…',70+Math.min(29,p*30)));
 await ff.load({coreURL:await util.toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js','text/javascript'),wasmURL:await util.toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm','application/wasm')});
 window.FFmpegWASM=ff;return ff;
}
async function run(){
 cancelled=false; if(download)download.hidden=true;if(video)video.hidden=true;
 if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
 if(cancel)cancel.hidden=false; if(convert)convert.disabled=true;
 try{
  const watch=input.value.trim(); if(!watch)throw new Error('Paste a watch URL first.');
  const r=await fetch('/api/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:watch})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not start conversion.');jobId=d.jobId;
  let j; for(;;){if(cancelled)throw new Error('Cancelled.');j=await getJob();setStatus(j.status,Math.min(15,j.progress||0));if(j.sourceReady)break;if(j.error)throw new Error(j.error);await wait(500);}
  const src=await getSource();
  setStatus('Preparing stream…',18);
  const pr=await fetch(src.url,{headers:src.headers||{}});if(!pr.ok)throw new Error(`Could not fetch playlist (HTTP ${pr.status}). If this keeps happening, the media host may block browser access.`);
  const text=await pr.text();const parsed=parsePlaylist(text,src.url);
  const ff=await loadFFmpeg();
  const local=parsed.lines.slice();
  const concurrency=6;let next=0,done=0;
  async function worker(){while(true){if(cancelled)throw new Error('Cancelled.');const n=next++;if(n>=parsed.segs.length)return;const s=parsed.segs[n];const rr=await fetch(s.url,{headers:src.headers||{}});if(!rr.ok)throw new Error(`Segment ${n+1} failed (HTTP ${rr.status}).`);const data=new Uint8Array(await rr.arrayBuffer());const ext=(new URL(s.url).pathname.match(/\.([A-Za-z0-9]+)$/)?.[1]||'bin').toLowerCase();const name=`seg_${String(n).padStart(6,'0')}.${ext}`;await ff.writeFile(name,data);local[s.line]=name;done++;setStatus(`Downloading segments… ${done}/${parsed.segs.length}`,20+(done/parsed.segs.length)*45);}}
  await Promise.all(Array.from({length:concurrency},worker));
  await ff.writeFile('input.m3u8',new TextEncoder().encode(local.join('\n')));
  const out='output.mp4';setStatus('Converting on your PC…',68);
  await ff.exec(['-allowed_extensions','ALL','-i','input.m3u8','-c:v','libx264','-preset','ultrafast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
  const bytes=await ff.readFile(out);objectUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
  if(filename)filename.value=basename(watch)+'.mp4';
  if(download){download.hidden=false;download.onclick=()=>{const a=document.createElement('a');a.href=objectUrl;a.download=(filename?.value.trim()||basename(watch)+'.mp4');a.click();};}
  if(video){video.src=objectUrl;video.hidden=false;}
  setStatus('Ready — MP4 created on your PC.',100);
 }catch(e){setStatus(e.message||'Conversion failed.',0);}
 finally{if(cancel)cancel.hidden=true;if(convert)convert.disabled=false;}
}
if(form)document.addEventListener('submit',e=>{e.preventDefault();e.stopImmediatePropagation();run();},true);
if(cancel)cancel.addEventListener('click',async()=>{cancelled=true;if(jobId)fetch(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{});setStatus('Cancelling…',0);});
})();
