const express=require('express');
const helmet=require('helmet');
const {chromium}=require('playwright');
const crypto=require('crypto');
const path=require('path');
const fs=require('fs');

const app=express();
const PORT=process.env.PORT||10000;
const PUBLIC=path.join(__dirname,'public');
const SITE_HOSTS=new Set(['kodasusaka.com','pinkueiga.net','18korean.net','18eu.net','cat3film.com']);
const MEDIA_HOSTS=new Set(['hls.kodasusaka.com','hls.asuka-vod.site','pk.asuka-vod.site']);
const ASSET_HOSTS=new Set([...SITE_HOSTS]);
const jobs=new Map();

app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'1mb'}));
function host(h){return(h||'').toLowerCase().replace(/^www\./,'')}
function watchOk(raw){try{const u=new URL(raw);return u.protocol==='https:'&&SITE_HOSTS.has(host(u.hostname))&&u.pathname.startsWith('/watch/')}catch{return false}}
function mediaOk(raw){try{const u=new URL(raw);return u.protocol==='https:'&&MEDIA_HOSTS.has(host(u.hostname))}catch{return false}}
function assetOk(raw){try{const u=new URL(raw);return u.protocol==='https:'&&ASSET_HOSTS.has(host(u.hostname))&&u.pathname.startsWith('/uploads/')}catch{return false}}
function mediaProxy(raw){return`/api/media?url=${encodeURIComponent(raw)}`}
function assetProxy(raw){return`/assets/proxy?url=${encodeURIComponent(raw)}`}

function renderIndex(){
  let html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8');
  const assets=[
    'https://kodasusaka.com/uploads/favicon-90237e8fbaa8.png',
    'https://kodasusaka.com/uploads/logo-jp-dark-bf009ef98d20.png',
    'https://pinkueiga.net/uploads/logo-pk-08b28bb78660.png',
    'https://18korean.net/uploads/logo18korean-57db9d75a8bd.png',
    'https://18eu.net/uploads/logo-18eu-0162fac9d6c7.png',
    'https://cat3film.com/uploads/cat3logo-7af8e6baca9e.png'
  ];
  for(const raw of assets)html=html.split(raw).join(assetProxy(raw));
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace(/<script\s+src=["'][^"']*client-fast\.js[^"']*["'][^>]*><\/script>/gi,'');
  html=html.replace('</body>','<script src="/client-fast.js?v=3"></script></body>');
  return html;
}
app.get('/',(req,res)=>{try{res.set('Cache-Control','no-store,no-cache,must-revalidate,proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.type('html').send(renderIndex())}catch{res.sendStatus(500)}});

app.use(express.static(PUBLIC,{maxAge:'1h'}));

app.get('/assets/proxy',async(req,res)=>{try{
  const raw=String(req.query.url||'');
  if(!assetOk(raw))return res.sendStatus(400);
  const u=new URL(raw);
  const r=await fetch(u,{headers:{referer:`https://${host(u.hostname)}/`},redirect:'follow',signal:AbortSignal.timeout(15000)});
  if(!r.ok)return res.sendStatus(r.status);
  res.set('Cache-Control','public,max-age=86400');
  res.set('Content-Type',r.headers.get('content-type')||'image/png');
  res.send(Buffer.from(await r.arrayBuffer()));
}catch{res.sendStatus(502)}});

app.get('/api/media',async(req,res)=>{try{
  const raw=String(req.query.url||'');
  if(!mediaOk(raw))return res.status(400).send('Unsupported media URL.');
  const u=new URL(raw);
  const headers={};
  if(req.query.referer)headers.referer=String(req.query.referer);
  const r=await fetch(u,{headers,redirect:'follow',signal:AbortSignal.timeout(30000)});
  if(!r.ok)return res.status(r.status).send(`Upstream HTTP ${r.status}`);
  res.set('Cache-Control','no-store');
  res.set('Content-Type',r.headers.get('content-type')||'application/octet-stream');
  res.send(Buffer.from(await r.arrayBuffer()));
}catch(e){res.status(502).send(e.message||'Media proxy failed.')}});

async function text(url,headers={},ms=12000){const r=await fetch(url,{headers,signal:AbortSignal.timeout(ms)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.text()}
function sourceApi(site,id){return`https://${site}/api/v1/episodes/${encodeURIComponent(id)}/sources`}
function makeJob(url){const j={id:crypto.randomUUID(),url,status:'Finding video',progress:0,source:null,error:null};jobs.set(j.id,j);return j}
async function discover(watch,j){const u=new URL(watch),site=host(u.hostname);let browser;try{
  j.status='Finding video';j.progress=5;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();let captured=null;
  page.on('response',async r=>{if(/\/api\/v1\/episodes\/[^/]+\/sources(?:\?|$)/.test(r.url())){try{captured=await r.json()}catch{}}});
  await page.goto(watch,{waitUntil:'domcontentloaded',timeout:20000});
  j.status='Getting video source';j.progress=25;
  const html=await page.content();
  const ids=[...html.matchAll(/(?:episode(?:Id|ID)|episode_id|episodeId)\s*["'=:]+\s*["']?([A-Za-z0-9_-]{3,})/gi)].map(m=>m[1]);
  const pick=d=>(d?.sources||[]).find(x=>x&&typeof x.file==='string'&&/^https:\/\//.test(x.file));
  let h=pick(captured);
  if(h)return{url:h.file,headers:{referer:watch,origin:`https://${site}`}};
  for(const id of [...new Set(ids)].slice(0,12)){try{const d=JSON.parse(await text(sourceApi(site,id),{accept:'application/json',referer:watch,origin:`https://${site}`}));h=pick(d);if(h)return{url:h.file,headers:{referer:watch,origin:`https://${site}`}}}catch{}}
  await page.waitForTimeout(3500);
  h=pick(captured);
  if(h)return{url:h.file,headers:{referer:watch,origin:`https://${site}`}};
  throw Error('Could not find the video source on this page.');
}finally{if(browser)await browser.close().catch(()=>{})}}

app.get('/api/health',(q,r)=>r.json({ok:true,clientSide:true}));
app.post('/api/convert',(req,res)=>{const raw=String(req.body?.url||'').trim();if(!watchOk(raw))return res.status(400).json({error:'Enter a supported watch URL.'});const j=makeJob(raw);res.json({jobId:j.id});discover(raw,j).then(s=>{if(!mediaOk(s.url))throw Error('Unsupported media source.');j.source=s;j.status='Ready to download';j.progress=100}).catch(e=>{j.status='Failed';j.error=e.message||'Source discovery failed.'})});
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});res.json({id:j.id,status:j.status,progress:j.progress,sourceReady:!!j.source,error:j.error})});
app.get('/api/jobs/:id/source',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});if(!j.source)return res.status(409).json({error:'Source not ready.'});res.json(j.source)});
app.delete('/api/jobs/:id',(req,res)=>{jobs.delete(req.params.id);res.json({ok:true})});
app.use((req,res)=>{if(req.method==='GET'&&req.accepts('html')){try{res.set('Cache-Control','no-store');res.type('html').send(renderIndex())}catch{return res.sendStatus(500)}}else res.sendStatus(404)});
app.listen(PORT,()=>console.log(`JP Downloader listening on ${PORT}`));
