const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const jobs = new Map();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeName(s) {
  return (s || 'video').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'video';
}

function valid(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('Only HTTP(S) URLs are supported.');
  return u;
}

function proc(cmd, args, onLine, job) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    if (job) job.process = p;
    let err = '';
    p.stdout.on('data', d => onLine?.(d.toString()));
    p.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      onLine?.(s);
    });
    p.on('error', rej);
    p.on('close', c => {
      if (job) job.process = null;
      if (job?.cancelled) return rej(Error('Cancelled'));
      c === 0 ? res() : rej(Error(`${cmd} exited with code ${c}\n${err.slice(-4000)}`));
    });
  });
}

async function resolve(watch, job) {
  job.status = 'Loading watch page…';
  const browser = await chromium.launch({ headless: true });
  job.browser = browser;
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    });
    let found = null;
    page.on('response', async r => {
      if (!/\/api\/v1\/episodes\/[^/]+\/sources(?:\?|$)/i.test(r.url())) return;
      try {
        const j = await r.json();
        if (j && Array.isArray(j.sources)) found = { apiUrl: r.url(), json: j };
      } catch {}
    });
    await page.goto(watch, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      const heading = await page.locator('main#main h1.cls-watch-title').first().innerText({ timeout: 5000 });
      if (heading.trim()) job.displayName = heading.trim().replace(/^Watch\s+/i, '').trim();
    } catch {}
    const end = Date.now() + 20000;
    while (!found && Date.now() < end && !job.cancelled) await page.waitForTimeout(250);
    if (job.cancelled) throw Error('Cancelled');
    if (!found) throw Error('No /api/v1/episodes/<id>/sources response was observed on this watch page.');
    const hls = found.json.sources.find(s => s && typeof s.file === 'string' && (String(s.type).toLowerCase() === 'hls' || /\.m3u8(?:$|\?)/i.test(s.file)));
    if (!hls) throw Error('The sources response did not contain an HLS source.');
    job.apiUrl = found.apiUrl;
    job.hlsUrl = hls.file;
    job.status = 'Found HLS source.';
    return hls.file;
  } finally {
    await browser.close();
    job.browser = null;
  }
}

async function getPlaylistText(hls) {
  const base = hls.endsWith('/') ? hls : hls + '/';
  const r = await fetch(new URL('index.json', base));
  if (!r.ok) throw Error(`Could not fetch index.json (${r.status}).`);
  return { base, text: await r.text() };
}

async function playlist(hls, dir) {
  const { base, text } = await getPlaylistText(hls);
  const lines = text.split(/\r?\n/);
  const out = lines.map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    try { return new URL(t, base).href; } catch { return t; }
  });
  const file = path.join(dir, 'local.m3u8');
  await fsp.writeFile(file, out.join('\n'), 'utf8');
  return file;
}

async function parallelPlaylist(hls, dir, job) {
  const { base, text } = await getPlaylistText(hls);
  const lines = text.split(/\r?\n/);
  const entries = [];
  let sequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    let url;
    try { url = new URL(t, base).href; } catch { continue; }
    entries.push({ index: i, url, local: `segment-${String(sequence++).padStart(6, '0')}.bin` });
  }

  if (!entries.length) throw Error('The HLS playlist contained no media segments.');

  job.status = `Downloading ${entries.length} segments in parallel…`;
  job.segmentTotal = entries.length;
  job.segmentDone = 0;
  const concurrency = Math.max(2, Math.min(12, Number(process.env.HLS_DOWNLOAD_CONCURRENCY) || 8));
  let next = 0;
  let firstError = null;

  async function worker() {
    while (!firstError && !job.cancelled) {
      const n = next++;
      if (n >= entries.length) return;
      const item = entries[n];
      try {
        const r = await fetch(item.url);
        if (!r.ok) throw Error(`Segment download failed (${r.status}).`);
        const buf = Buffer.from(await r.arrayBuffer());
        await fsp.writeFile(path.join(dir, item.local), buf);
        job.segmentDone++;
        job.progress = Math.min(70, (job.segmentDone / entries.length) * 70);
      } catch (e) {
        firstError = e;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  if (job.cancelled) throw Error('Cancelled');
  if (firstError) throw firstError;

  const out = lines.map((line, i) => {
    const item = entries.find(x => x.index === i);
    return item ? item.local : line;
  });
  const file = path.join(dir, 'local.m3u8');
  await fsp.writeFile(file, out.join('\n'), 'utf8');
  return file;
}

async function duration(file, job) {
  try {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', '-allowed_extensions', 'ALL', '-extension_picky', '0', file];
    let out = '';
    await proc(FFPROBE, args, x => out += x, job);
    const n = parseFloat(out.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

async function ffmpegConvert(m3u8, out, job, mode) {
  const baseArgs = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', '-allowed_extensions', 'ALL', '-extension_picky', '0', '-i', m3u8];
  let args;
  if (mode === 'copy') {
    args = [...baseArgs, '-c', 'copy', '-movflags', '+faststart', out];
  } else {
    const preset = mode === 'fast' ? 'ultrafast' : (process.env.FFMPEG_PRESET || 'medium');
    args = [...baseArgs, '-c:v', 'libx264', '-preset', preset, '-crf', process.env.FFMPEG_CRF || '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
  }
  await proc(FFMPEG, args, line => {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      job.seconds = +m[1] * 3600 + +m[2] * 60 + +m[3];
      if (job.duration) {
        const encodeProgress = Math.min(30, job.seconds / job.duration * 30);
        job.progress = mode === 'parallel' ? Math.max(70, 70 + encodeProgress) : Math.max(0, encodeProgress);
      }
    }
  }, job);
}

async function convert(job, watch, method) {
  let dir;
  try {
    const u = new URL(watch);
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = parts.pop() || 'video';
    const ep = u.searchParams.get('ep');
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hls-converter-'));
    job.dir = dir;

    const hls = await resolve(watch, job);
    if (job.cancelled) throw Error('Cancelled');

    job.status = 'Downloading playlist…';
    let m3u8;
    if (method === 'parallel') m3u8 = await parallelPlaylist(hls, dir, job);
    else m3u8 = await playlist(hls, dir);

    job.duration = await duration(m3u8, job);
    const sourceName = job.displayName || slug;
    const name = safeName(ep ? `${sourceName}-ep-${ep}` : sourceName);
    job.name = ep ? `${sourceName} · Episode ${ep}` : sourceName;
    job.filename = `${name}.mp4`;
    const out = path.join(dir, `${name}.mp4`);

    job.status = method === 'copy' ? 'Remuxing without re-encoding…' : method === 'fast' ? 'Converting with fast encoding…' : method === 'parallel' ? 'Converting downloaded segments…' : 'Converting with FFmpeg…';

    try {
      await ffmpegConvert(m3u8, out, job, method === 'parallel' ? 'standard' : method);
    } catch (e) {
      if (method !== 'copy') throw e;
      job.status = 'Direct copy was incompatible; switching to standard conversion…';
      await ffmpegConvert(m3u8, out, job, 'standard');
    }

    job.status = 'Verifying MP4…';
    await proc(FFPROBE, ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=nw=1', out], null, job);
    job.output = out;
    job.progress = 100;
    job.status = 'Done';
    job.done = true;
  } catch (e) {
    if (job.cancelled || e.message === 'Cancelled') {
      job.status = 'Cancelled';
      job.error = null;
    } else {
      job.status = 'Error';
      job.error = e.message;
    }
    job.done = true;
  } finally {
    job.process = null;
    job.browser = null;
  }
}

app.post('/api/convert', (req, res) => {
  try {
    const u = valid(req.body?.url);
    const allowed = ['standard', 'fast', 'copy', 'parallel'];
    const method = allowed.includes(req.body?.method) ? req.body.method : 'standard';
    const id = crypto.randomUUID();
    const job = { id, method, status: 'Starting…', done: false, createdAt: Date.now(), progress: 0, seconds: 0, duration: 0, cancelled: false };
    jobs.set(id, job);
    convert(job, u.href, method);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found.' });
  res.json({
    id: j.id, status: j.status, done: !!j.done, error: j.error || null,
    seconds: j.seconds || 0, duration: j.duration || 0, progress: j.progress || 0,
    name: j.name || null, filename: j.filename || null, method: j.method || 'standard',
    download: j.done && j.output ? `/api/jobs/${j.id}/download` : null,
    stream: j.done && j.output ? `/api/jobs/${j.id}/stream` : null
  });
});

app.delete('/api/jobs/:id', async (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found.' });
  if (j.done) {
    try { if (j.dir) await fsp.rm(j.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(j.id);
    return res.json({ ok: true });
  }
  j.cancelled = true;
  try { if (j.process) j.process.kill('SIGTERM'); } catch {}
  try { if (j.browser) await j.browser.close(); } catch {}
  res.json({ ok: true });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j?.output || !j.done || !fs.existsSync(j.output)) return res.status(404).send('File is not ready.');
  res.download(j.output, j.filename || 'video.mp4', async () => {
    try { await fsp.rm(j.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(j.id);
  });
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j?.output || !j.done || !fs.existsSync(j.output)) return res.status(404).send('File is not ready.');
  res.sendFile(j.output, { headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' } });
});

setInterval(async () => {
  const cut = Date.now() - 7200000;
  for (const [id, j] of jobs) if (j.createdAt < cut) {
    try { if (j.process) j.process.kill('SIGTERM'); } catch {}
    try { if (j.browser) await j.browser.close(); } catch {}
    try { if (j.dir) await fsp.rm(j.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(id);
  }
}, 600000).unref();

app.listen(PORT, () => console.log(`JP Downloader: http://localhost:${PORT}`));
