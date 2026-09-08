const express = require('express');
const helmet = require('helmet');
const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const jobs = new Map();
const rate = new Map();
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 1));
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Math.max(1, Number(process.env.RATE_MAX || 5));
const REQUEST_TIMEOUT_MS = 30000;
const SUPPORTED_HOSTS = new Set(['kodasusaka.com','pinkueiga.net','18korean.net','18eu.net','cat3film.com']);
const MEDIA_HOSTS = new Set((process.env.ALLOWED_MEDIA_HOSTS || 'hls.kodasusaka.com,pk.asuka-vod.site').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({ limit: '10kb' }));
app.get('/', async (req,res,next)=>{try{const file=path.join(__dirname,'public','index.html');let html=await fsp.readFile(file,'utf8');res.send(html)}catch(e){next(e)}});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health',(req,res)=>res.json({ok:true}));
function safeName(s){return(s||'video').replace(/[^a-z0-9._ -]+/gi,'-').replace(/^[- ]+|[- ]+$/g,'').slice(0,120)||'video'}
function hostAllowed(host,allow){const h=String(host||'').toLowerCase().replace(/\.$/,'');for(const base of allow)if(h===base||h.endsWith('.'+base))return true;return false}
function valid(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw Error('Only HTTP(S) URLs are supported.');if(!hostAllowed(u.hostname,SUPPORTED_HOSTS))throw Error('This site is not supported.');if(!/^\/watch\/[^/]+\/?$/i.test(u.pathname))throw Error('Please enter a supported watch-page URL.');return u}
function mediaValid(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||!hostAllowed(u.hostname,MEDIA_HOSTS)&&!hostAllowed(u.hostname,SUPPORTED_HOSTS))throw Error('The video source came from an untrusted host.');return u}
function fetchWithTimeout(url,options={}){const c=new AbortController(),t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);return fetch(url,{...options,signal:c.signal}).finally(()=>clearTimeout(t))}
function clientKey(req){return req.ip||req.socket.remoteAddress||'unknown'}
function rateLimited(req){const now=Date.now(),key=clientKey(req),old=(rate.get(key)||[]).filter(t=>now-t<RATE_WINDOW_MS);if(old.length>=RATE_MAX){rate.set(key,old);return true}old.push(now);rate.set(key,old);return false}
function activeJobs(){let n=0;for(const j of jobs.values())if(!j.done)n++;return n}
function killProcessTree(p){return new Promise(resolve=>{if(!p||p.killed||p.exitCode!==null)return resolve();if(process.platform==='win32')execFile('taskkill',['/pid',String(p.pid),'/T','/F'],()=>resolve());else{try{p.kill('SIGTERM')}catch{}setTimeout(()=>{try{if(p.exitCode===null)p.kill('SIGKILL')}catch{}resolve()},1500)}})}
function proc(cmd,args,onLine,job){return new Promise((res,rej)=>{const p=spawn(cmd,args,{windowsHide:true,detached:process.platform!=='win32'});if(job)job.process=p;let err='';p.stdout.on('data',d=>onLine?.(d.toString()));p.stderr.on('data',d=>{const s=d.toString();err+=s;onLine?.(s)});p.on('error',rej);p.on('close',c=>{if(job&&job.process===p)job.process=null;if(job?.cancelled)return rej(Error('Cancelled'));c===0?res():rej(Error(`${cmd} exited with code ${c}\n${err.slice(-2000)}`))})})}
async function resolve(watch,job){
  job.status='Loading watch page…';
  const browser=await chromium.launch({headless:true});
  job.browser=browser;
  try{
    const page=await browser.newPage({
      userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      viewport:{width:1280,height:720},
      locale:'en-US'
    });
    let found=null;
    const capture=async r=>{
      if(found||!/\/api\/v1\/episodes\/[^/]+\/sources(?:\?|$)/i.test(r.url()))return;
      try{
        const j=await r.json();
        if(j&&Array.isArray(j.sources))found={apiUrl:r.url(),json:j};
      }catch{}
    };
    page.on('response',capture);
    page.on('requestfailed',r=>console.warn(`[job ${job.id}] request failed: ${r.url()} ${r.failure()?.errorText||''}`));
    page.on('pageerror',e=>console.warn(`[job ${job.id}] page error: ${e.message}`));
    await page.goto(watch,{waitUntil:'domcontentloaded',timeout:REQUEST_TIMEOUT_MS});
    try{await page.waitForLoadState('load',{timeout:10000})}catch{}
    try{await page.locator('main#main h1.cls-watch-title').first().waitFor({state:'visible',timeout:5000})}catch{}
    try{const heading=await page.locator('main#main h1.cls-watch-title').first().innerText({timeout:5000});if(heading.trim())job.displayName=heading.trim().replace(/^Watch\s+/i,'').trim()}catch{}
    const waitForSource=async ms=>{const end=Date.now()+ms;while(!found&&Date.now()<end&&!job.cancelled)await page.waitForTimeout(250);return !!found};
    await waitForSource(30000);
    if(!found&&!job.cancelled){
      console.log(`[job ${job.id}] No sources response after initial load; reloading watch page.`);
      await page.reload({waitUntil:'domcontentloaded',timeout:REQUEST_TIMEOUT_MS}).catch(()=>{});
      try{await page.waitForLoadState('load',{timeout:10000})}catch{}
      await waitForSource(30000);
    }
    if(job.cancelled)throw Error('Cancelled');
    if(!found)throw Error('We could not find a video source on this page. Make sure the URL is a valid supported watch page.');
    const hls=found.json.sources.find(s=>s&&typeof s.file==='string'&&(String(s.type).toLowerCase()==='hls'||/\.m3u8(?:$|\?)/i.test(s.file)));
    if(!hls)throw Error('This video does not have a compatible HLS source.');
    const sourceUrl=mediaValid(hls.file);
    job.apiUrl=found.apiUrl;
    job.hlsUrl=sourceUrl.href;
    job.status='Found HLS source.';
    return sourceUrl.href;
  }finally{await browser.close().catch(()=>{});job.browser=null}
}
async function playlist(hls,dir){const source=mediaValid(hls),base=source.href.endsWith('/')?source.href:source.href+'/';const r=await fetchWithTimeout(new URL('index.json',base));if(!r.ok)throw Error(`Could not fetch the video playlist (${r.status}).`);const lines=(await r.text()).split(/\r?\n/);const out=lines.map(line=>{const t=line.trim();if(!t||t.startsWith('#'))return line;try{return new URL(t,base).href}catch{return t}});for(const line of out){const t=line.trim();if(t&&!t.startsWith('#'))mediaValid(t)}const file=path.join(dir,'local.m3u8');await fsp.writeFile(file,out.join('\n'),'utf8');return file}
async function duration(file,job){try{const args=['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1','-protocol_whitelist','file,http,https,tcp,tls,crypto,data','-allowed_extensions','ALL','-extension_picky','0',file];let out='';await proc(FFPROBE,args,x=>out+=x,job);const n=parseFloat(out.trim());return Number.isFinite(n)&&n>0?n:0}catch{return 0}}
async function convert(job,watch){let dir;try{const u=new URL(watch),parts=u.pathname.split('/').filter(Boolean),slug=parts.pop()||'video',ep=u.searchParams.get('ep');dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hls-converter-'));job.dir=dir;const hls=await resolve(watch,job);if(job.cancelled)throw Error('Cancelled');job.status='Downloading playlist…';const m3u8=await playlist(hls,dir);job.duration=await duration(m3u8,job);if(job.cancelled)throw Error('Cancelled');const sourceName=job.displayName||slug;const name=safeName(ep?`${sourceName}-ep-${ep}`:sourceName);job.name=ep?`${sourceName} · Episode ${ep}`:sourceName;job.filename=`${name}.mp4`;const out=path.join(dir,`${name}.mp4`);job.status='Converting with fast encoding (~2.5× faster)…';await proc(FFMPEG,['-protocol_whitelist','file,http,https,tcp,tls,crypto,data','-allowed_extensions','ALL','-extension_picky','0','-i',m3u8,'-c:v','libx264','-preset','ultrafast','-crf',process.env.FFMPEG_CRF||'20','-c:a','aac','-b:a','192k','-movflags','+faststart',out],line=>{const m=line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);if(m){job.seconds=+m[1]*3600+ +m[2]*60+ +m[3];if(job.duration)job.progress=Math.min(99,job.seconds/job.duration*100)}},job);if(job.cancelled)throw Error('Cancelled');job.status='Verifying MP4…';await proc(FFPROBE,['-v','error','-show_entries','format=format_name','-of','default=nw=1',out],null,job);if(job.cancelled)throw Error('Cancelled');job.output=out;job.progress=100;job.status='Done';job.done=true}catch(e){if(job.cancelled||e.message==='Cancelled'){job.status='Cancelled';job.error=null}else{console.error(`[job ${job.id}]`,e);job.status='Error';job.error='The conversion failed. Please try again.'}job.done=true}finally{job.process=null;job.browser=null}}
app.post('/api/convert',(req,res)=>{try{if(rateLimited(req))return res.status(429).json({error:'Too many conversion requests. Please wait a few minutes and try again.'});if(activeJobs()>=MAX_CONCURRENT)return res.status(429).json({error:'The converter is busy right now. Please try again shortly.'});const u=valid(req.body?.url),id=crypto.randomUUID(),job={id,method:'fast',status:'Starting…',done:false,createdAt:Date.now(),progress:0,seconds:0,duration:0,cancelled:false};jobs.set(id,job);convert(job,u.href);res.json({id})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});res.json({id:j.id,status:j.status,done:!!j.done,error:j.error||null,seconds:j.seconds||0,duration:j.duration||0,progress:j.progress||0,name:j.name||null,filename:j.filename||null,method:'fast',download:j.done&&j.output?`/api/jobs/${j.id}/download`:null,stream:j.done&&j.output?`/api/jobs/${j.id}/stream`:null})});
app.delete('/api/jobs/:id',async(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});j.cancelled=true;j.status='Cancelling…';try{if(j.process)await killProcessTree(j.process)}catch{}try{if(j.browser)await j.browser.close()}catch{}if(j.dir){try{await fsp.rm(j.dir,{recursive:true,force:true})}catch{}}j.process=null;j.browser=null;j.done=true;j.output=null;j.status='Cancelled';j.error=null;return res.json({ok:true,status:'Cancelled'})});
app.get('/api/jobs/:id/download',(req,res)=>{const j=jobs.get(req.params.id);if(!j?.output||!j.done||!fs.existsSync(j.output))return res.status(404).send('File is not ready.');const requested=typeof req.query.name==='string'?req.query.name.trim():'';const filename=requested?`${safeName(requested.replace(/\.mp4$/i,''))}.mp4`:(j.filename||'video.mp4');res.download(j.output,filename,async()=>{try{await fsp.rm(j.dir,{recursive:true,force:true})}catch{}jobs.delete(j.id)})});
app.get('/api/jobs/:id/stream',(req,res)=>{const j=jobs.get(req.params.id);if(!j?.output||!j.done||!fs.existsSync(j.output))return res.status(404).send('File is not ready.');res.sendFile(j.output,{headers:{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Disposition':'inline'}})});
setInterval(async()=>{const cut=Date.now()-7200000;for(const[id,j]of jobs)if(j.createdAt<cut){try{if(j.process)await killProcessTree(j.process)}catch{}try{if(j.browser)await j.browser.close()}catch{}try{if(j.dir)await fsp.rm(j.dir,{recursive:true,force:true})}catch{}jobs.delete(id)}for(const[key,times]of rate){if(!times.some(t=>Date.now()-t<RATE_WINDOW_MS))rate.delete(key)}},600000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`JP Downloader listening on port ${PORT}`));
