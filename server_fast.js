const express = require('express');
const helmet = require('helmet');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC = path.join(__dirname, 'public');
const SITE_HOSTS = new Set(['kodasusaka.com','pinkueiga.net','18korean.net','18eu.net','cat3film.com','www.kodasusaka.com','www.pinkueiga.net','www.18korean.net','www.18eu.net','www.cat3film.com']);
const MEDIA_HOSTS = new Set(['hls.kodasusaka.com','hls.asuka-vod.site','pk.asuka-vod.site']);
const jobs = new Map();

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC, { maxAge: '1h' }));

function cleanHost(h){ return (h || '').toLowerCase().replace(/^www\./,''); }
function validWatch(raw){
  try { const u = new URL(raw); return u.protocol === 'https:' && SITE_HOSTS.has(cleanHost(u.hostname)) && /\/watch\//.test(u.pathname); }
  catch { return false; }
}
function validMedia(raw){
  try { const u = new URL(raw); return u.protocol === 'https:' && MEDIA_HOSTS.has(cleanHost(u.hostname)); }
  catch { return false; }
}
function makeJob(url){ const id=crypto.randomUUID(); const j={id,url,status:'Finding video',progress:0,source:null,error:null,created:Date.now()}; jobs.set(id,j); return j; }
async function fetchText(url, headers={}, timeout=12000){ const r=await fetch(url,{headers,signal:AbortSignal.timeout(timeout)}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
function sourceUrlFor(site,id){ return `https://${site}/api/v1/episodes/${encodeURIComponent(id)}/sources`; }

async function discover(watch, job){
  const u=new URL(watch), site=cleanHost(u.hostname); let browser;
  try {
    browser=await chromium.launch({headless:true}); const page=await browser.newPage(); let captured=null;
    page.on('response',async res=>{ if(/\/api\/v1\/episodes\/[^/]+\/sources(?:\?|$)/.test(res.url())){try{captured=await res.json();}catch{}} });
    await page.goto(watch,{waitUntil:'domcontentloaded',timeout:20000}); job.status='Getting video source'; job.progress=20;
    const html=await page.content();
    const ids=[...html.matchAll(/(?:episode(?:Id|ID)|episode_id|episodeId|id)\s*["'=:]+\s*["']?([A-Za-z0-9_-]{3,})/gi)].map(m=>m[1]);
    const candidates=[...new Set(ids)].slice(0,12).map(id=>sourceUrlFor(site,id));
    const use=(data)=>{const h=(data?.sources||[]).find(x=>x&&typeof x.file==='string'&&/^https:\/\//.test(x.file));return h?{url:h.file,headers:{referer:watch,origin:`https://${site}`}}:null;};
    const cap=use(captured); if(cap)return cap;
    for(const api of candidates){try{const x=use(JSON.parse(await fetchText(api,{'accept':'application/json','referer':watch,'origin':`https://${site}`})));if(x)return x;}catch{}}
    await page.waitForTimeout(3500); const late=use(captured); if(late)return late;
    throw new Error('Could not find the video source on this page.');
  } finally { if(browser)await browser.close().catch(()=>{}); }
}

app.get('/api/health',(req,res)=>res.json({ok:true,clientSide:true}));
app.post('/api/convert',async(req,res)=>{ const watch=String(req.body?.url||'').trim(); if(!validWatch(watch))return res.status(400).json({error:'Enter a supported watch URL.'}); const job=makeJob(watch); res.json({jobId:job.id}); discover(watch,job).then(src=>{if(!validMedia(src.url))throw new Error('Unsupported media source.');job.source=src;job.status='Ready to download';job.progress=100;}).catch(e=>{job.status='Failed';job.error=e.message||'Source discovery failed.';}); });
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});res.json({id:j.id,status:j.status,progress:j.progress,sourceReady:!!j.source,error:j.error});});
app.get('/api/jobs/:id/source',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found.'});if(!j.source)return res.status(409).json({error:'Source not ready.'});res.json(j.source);});
app.delete('/api/jobs/:id',(req,res)=>{jobs.delete(req.params.id);res.json({ok:true});});

app.get('/',(req,res)=>{let html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8');if(!html.includes('client-fast.js'))html=html.replace(/<\/body>/i,'<script src="/client-fast.js"></script></body>');res.type('html').send(html);});
app.use((req,res,next)=>{if(req.method==='GET'&&req.accepts('html')){let html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8');if(!html.includes('client-fast.js'))html=html.replace(/<\/body>/i,'<script src="/client-fast.js"></script></body>');return res.type('html').send(html);}next();});
app.listen(PORT,()=>console.log(`JP Downloader listening on ${PORT}`));
