// AXP Intelligence server: zero dependencies. Serves the dashboard and runs the council.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCouncil } from './council.js';
import { loadConfig, validateConfig, keyStatus, agentList, modelSummary } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// Minimal .env loader (no dotenv dependency)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env, fine */ }

// Common mistake: key pasted into .env.example (never read, and it's committed to git)
try {
  const ex = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  if (/^[A-Z0-9_]*API_KEY=\S+/m.test(ex)) {
    console.warn('\n  ⚠  An API key is filled in inside .env.example, which is NOT read (and is tracked by git).\n     Move it to a file named .env, blank it in .env.example, and restart.\n');
  }
} catch { /* ignore */ }

const PORT = Number(process.env.PORT) || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};
const MAX_BODY = 30_000_000; // text + base64 PDFs (Anthropic's request limit is 32MB)
const MAX_PDFS = 3;
const MAX_PDF_BYTES = 15_000_000, MAX_TOTAL_PDF_BYTES = 20_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Upload too large (30MB max)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const cfg = loadConfig();
      const errs = validateConfig(cfg);
      if (errs.length) { res.end(JSON.stringify({ mode: 'setup', configErrors: errs, agents: [] })); return; }
      const keys = keyStatus(cfg);
      const models = modelSummary(cfg);
      res.end(JSON.stringify({
        mode: !keys.anyKey ? 'demo' : keys.missing.length ? 'setup' : 'live',
        missingKeys: keys.missing.map((m) => m.env), model: !keys.anyKey ? 'simulated' : models.label, models: models.ids,
        agents: agentList(cfg),
      }));
    } catch (e) { res.end(JSON.stringify({ mode: 'setup', configErrors: [e.message], agents: [] })); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/council') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return; }

    const document = String(payload.document || '').trim();
    const bad = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };

    // Validate PDF attachments: count, size and real PDF signature (never trust the filename)
    const rawAtt = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (rawAtt.length > MAX_PDFS) { bad(`Attach at most ${MAX_PDFS} PDFs.`); return; }
    const attachments = [];
    let total = 0;
    for (const a of rawAtt) {
      const data = typeof a?.data === 'string' ? a.data.replace(/\s/g, '') : '';
      const bytes = Math.floor(data.length * 0.75);
      const name = String(a?.name || 'attachment.pdf').slice(0, 200);
      if (!data || Buffer.from(data.slice(0, 16), 'base64').toString('latin1').indexOf('%PDF') !== 0) { bad(`"${name}" is not a valid PDF.`); return; }
      if (bytes > MAX_PDF_BYTES) { bad(`"${name}" is larger than ${MAX_PDF_BYTES / 1e6} MB.`); return; }
      total += bytes;
      attachments.push({ name, data });
    }
    if (total > MAX_TOTAL_PDF_BYTES) { bad(`PDFs total more than ${MAX_TOTAL_PDF_BYTES / 1e6} MB.`); return; }
    if (document.length < 20 && attachments.length === 0) { bad('Provide a document (at least 20 characters) or attach a PDF.'); return; }
    let cfg;
    try {
      cfg = loadConfig();
      const errs = validateConfig(cfg);
      if (errs.length) { bad('Config problem in config/council.json: ' + errs.join(' | ')); return; }
    } catch (e) { bad(e.message); return; }
    const keys = keyStatus(cfg);
    if (keys.anyKey && keys.missing.length) {
      bad('Missing API key: ' + keys.missing.map((m) => `${m.env} (provider "${m.provider}")`).join(', ') + '. Add it to .env, or point those agents at a provider you have a key for in config/council.json.');
      return;
    }
    const demo = !keys.anyKey;
    const rounds = Math.min(8, Math.max(4, Number(payload.rounds) || 4)); // never fewer than 4
    const focus = String(payload.focus || '').slice(0, 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    let aborted = false;
    res.on('close', () => { aborted = true; });
    const emit = (type, data = {}) => { if (!aborted) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };

    try {
      await runCouncil({ cfg, demo, document, attachments, rounds, focus, emit, isAborted: () => aborted });
    } catch (e) {
      console.error('[council]', e);
      emit('error', { message: e.message || 'Council failed' });
    }
    res.end();
    return;
  }

  // Static files
  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  let mode = 'DEMO (add an API key to .env for live agents)';
  try {
    const cfg = loadConfig(); const errs = validateConfig(cfg);
    if (errs.length) mode = 'CONFIG PROBLEM: ' + errs.join(' | ');
    else {
      const k = keyStatus(cfg);
      if (k.anyKey && k.missing.length) mode = 'SETUP NEEDED: missing ' + k.missing.map((m) => m.env).join(', ');
      else if (k.anyKey) mode = 'LIVE (' + modelSummary(cfg).ids.join(', ') + ')';
    }
  } catch (e) { mode = 'CONFIG PROBLEM: ' + e.message; }
  console.log(`\n  AXP Intelligence online → http://localhost:${PORT}`);
  console.log(`  Mode: ${mode}\n`);
});
