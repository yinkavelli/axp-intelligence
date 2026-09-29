// AXP Intelligence front end: no build step, no dependencies.
const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let agents = [];
const colorOf = (id) => agents.find((a) => a.id === id)?.color || '#4de1ff';
let lastReport = '';
let sessions = 0;
let running = false;
let attachments = []; // PDFs: { name, size, data(base64) }
const MAX_PDFS = 3, MAX_PDF_BYTES = 15_000_000, MAX_TOTAL = 20_000_000;
const spark = Array.from({ length: 40 }, () => 20);

/* ---------- Clock + telemetry sparkline ---------- */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
$('#clock').textContent = new Date().toLocaleTimeString('en-GB');
setInterval(() => {
  const busy = running ? 14 : 4;
  spark.push(Math.max(4, Math.min(36, spark[spark.length - 1] + (Math.random() - 0.5) * busy * 2)));
  spark.shift();
  $('#sparkLine').setAttribute('points', spark.map((v, i) => `${(i / (spark.length - 1)) * 200},${40 - v}`).join(' '));
}, 350);

/* ---------- Background particles ---------- */
(function bg() {
  const c = $('#bg'), ctx = c.getContext('2d');
  let w, h, pts;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size() {
    w = c.width = innerWidth; h = c.height = innerHeight;
    pts = Array.from({ length: Math.min(70, Math.floor(w * h / 26000)) }, () => ({
      x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    // faint grid
    ctx.strokeStyle = 'rgba(110,190,255,0.035)'; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (const p of pts) {
      if (!reduce) { p.x += p.vx; p.y += p.vy; }
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.fillStyle = 'rgba(77,225,255,.5)'; ctx.fillRect(p.x, p.y, 1.5, 1.5);
    }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = dx * dx + dy * dy;
      if (d < 14000) { ctx.strokeStyle = `rgba(77,225,255,${.09 * (1 - d / 14000)})`; ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke(); }
    }
    if (!reduce) requestAnimationFrame(draw);
  }
  addEventListener('resize', size); size(); draw();
})();

/* ---------- Stage helpers ---------- */
const NODE_POS = [[300, 36], [564, 300], [300, 564], [36, 300]]; // top, right, bottom, left (clockwise)
function buildLinks() {
  $('#links').innerHTML = agents.map((a, i) =>
    `<line class="link" id="link-${a.id}" x1="300" y1="300" x2="${NODE_POS[i][0]}" y2="${NODE_POS[i][1]}" style="--cx:${a.color}"/>`).join('');
}
function renderNodes() {
  document.querySelectorAll('.node').forEach((n, i) => {
    const a = agents[i];
    n.classList.toggle('hidden', !a);
    if (!a) return;
    n.dataset.agent = a.id;
    n.style.setProperty('--c', a.color);
    n.innerHTML = `<div class="n-name">${esc(a.name)}</div><div class="n-role">${esc(a.role)}</div>
      <div class="n-model">${esc(a.model)}</div>
      <div class="n-state"><i></i><span>Idle</span></div><div class="n-score"></div>`;
  });
  buildLinks();
  $('#tAgents').textContent = agents.length || '—';
}
function setNode(id, state, score) {
  const n = document.querySelector(`.node[data-agent="${id}"]`); if (!n) return;
  n.classList.toggle('thinking', state === 'thinking');
  n.classList.toggle('done', state === 'done');
  n.querySelector('.n-state span').textContent = { thinking: 'Analyzing', done: 'Reported', idle: 'Idle' }[state];
  if (score != null) n.querySelector('.n-score').textContent = score.toFixed(1);
  if (state === 'idle') n.querySelector('.n-score').textContent = '';
  $(`#link-${id}`)?.classList.toggle('on', state === 'thinking');
}
function setCore(num, label, busy) {
  $('#coreNum').textContent = num;
  $('#coreLbl').textContent = label;
  $('#core').classList.toggle('busy', !!busy);
}
function setGauge(pct) { $('#gVal').setAttribute('stroke-dasharray', `${Math.max(0, Math.min(100, pct))} 100`); }
function buildRounds(n) { $('#rounds').innerHTML = Array.from({ length: n }, () => '<i class="pip"></i>').join(''); }
function pip(round, cls) {
  const p = $('#rounds').children[round - 1]; if (!p) return;
  p.classList.remove('active', 'done'); if (cls) p.classList.add(cls);
}
function status(t) { $('#statusLine').textContent = t; }
function feed(cls, head, body, color) {
  const f = $('#feed'); f.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'entry ' + cls; if (color) el.style.setProperty('--c', color);
  const t = new Date().toLocaleTimeString('en-GB');
  el.innerHTML = `<div class="e-h"><span>${esc(head)}</span><span>${t}</span></div><div class="e-b">${esc(body)}</div>`;
  f.appendChild(el); f.scrollTop = f.scrollHeight;
}

/* ---------- Minimal markdown ---------- */
function md(src) {
  const lines = esc(src).split('\n'); let out = '', inList = false, inPara = false;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const close = () => { if (inList) { out += '</ul>'; inList = false; } if (inPara) { out += '</p>'; inPara = false; } };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^#{1,2}\s+(.*)/))) { close(); out += `<h2>${inline(m[1])}</h2>`; }
    else if ((m = l.match(/^#{3,6}\s+(.*)/))) { close(); out += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (inPara) close(); if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { if (inList) close(); if (!inPara) { out += '<p>'; inPara = true; } else out += '<br>'; out += inline(l); }
  }
  close(); return out;
}

/* ---------- Council run ---------- */
function handle(ev) {
  switch (ev.type) {
    case 'preflight_start':
      setCore('···', 'PREFLIGHT', true); status('Preflight: checking the brief for missing material…'); break;
    case 'preflight_ok':
      status('Preflight passed.'); break;
    case 'preflight_blocked':
      setCore('!', 'NEEDS INPUT', false);
      status('Council not convened. No tokens spent on the review.');
      feed('warn', 'Preflight · not convened', ev.message + (ev.missing?.length ? '\n\nMissing:\n' + ev.missing.map((m) => '• ' + m).join('\n') : ''));
      break;
    case 'intake_start':
      setCore('···', 'INTAKE', true); status(`Intake: reading ${ev.files.length} PDF${ev.files.length > 1 ? 's' : ''} once into a digest…`);
      feed('sys', 'Intake', `Reading: ${ev.files.join(', ')}`); break;
    case 'intake_done':
      feed('sys', 'Intake complete', `Digest ready (~${ev.words} words). The council will work from this instead of re-reading the PDF.\n\n${ev.preview}${ev.words > 90 ? '…' : ''}`); break;
    case 'start':
      agents = ev.agents; renderNodes(); buildRounds(ev.rounds);
      feed('sys', 'System', `Council convened: ${ev.rounds} rounds, ${agents.length} specialists (${ev.mode} mode).`);
      break;
    case 'round_start':
      pip(ev.round, 'active');
      agents.forEach((a) => setNode(a.id, 'idle'));
      setCore(`R${ev.round}`, `OF ${ev.rounds}`, true);
      status(`Round ${ev.round}/${ev.rounds}: specialists analyzing the draft…`);
      feed('sys', `Round ${ev.round}`, 'Specialists reviewing the current draft.');
      break;
    case 'agent_start': setNode(ev.agent, 'thinking'); break;
    case 'agent_done': {
      setNode(ev.agent, 'done', ev.score);
      const a = agents.find((x) => x.id === ev.agent);
      feed('agent', `${a?.name || ev.agent}${ev.score != null ? ' · ' + ev.score.toFixed(1) + '/10' : ''}`, ev.text, colorOf(ev.agent));
      break;
    }
    case 'synth_start':
      setCore('···', 'SYNTHESIS', true);
      status(`Round ${ev.round}: Orchestrator merging critiques into a revised draft…`);
      break;
    case 'synth_done':
      pip(ev.round, 'done');
      setGauge(ev.score); setCore(`${ev.score}%`, 'CONSENSUS', true);
      feed('orch', `Orchestrator · R${ev.round} · ${ev.score}%`, ev.summary + (ev.openIssues?.length ? '\n\nOpen:\n' + ev.openIssues.map((i) => '• ' + i).join('\n') : ''));
      break;
    case 'finalizing':
      status('Orchestrator composing the final response…'); setCore('···', 'FINALIZING', true); break;
    case 'final':
      lastReport = ev.report; setCore('✓', 'COMPLETE', false);
      status('Council complete. Final report ready.');
      agents.forEach((a) => setNode(a.id, 'idle'));
      $('#viewReport').classList.remove('hidden');
      feed('orch', 'Orchestrator', 'Final report delivered.');
      showReport(); break;
    case 'usage': {
      const tok = ev.inTokens + ev.outTokens;
      $('#tTokens').textContent = tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : String(tok);
      $('#tCost').textContent = ev.unpriced.length && !ev.usd ? 'n/a' : (ev.usd < 0.01 ? '<$0.01' : '$' + ev.usd.toFixed(2)) + (ev.unpriced.length ? '+' : '');
      feed('sys', 'Usage', `${ev.calls} calls · ${ev.inTokens.toLocaleString()} in / ${ev.outTokens.toLocaleString()} out tokens\n` +
        ev.byModel.map((m) => `• ${m.model}: ${m.calls} calls, ${(m.in + m.out).toLocaleString()} tokens${m.usd == null ? ' (no price set)' : ' ≈ $' + m.usd.toFixed(3)}`).join('\n') +
        (ev.usd != null ? '\nEstimate only. Prices come from config/council.json.' : ''));
      break;
    }
    case 'error':
      feed('err', 'Error', ev.message); status('Council interrupted: ' + ev.message); setCore('!', 'ERROR', false); break;
  }
}

async function run() {
  const document_ = $('#doc').value.trim();
  if (document_.length < 20 && !attachments.length) { status('Paste a document or attach a PDF first.'); $('#doc').focus(); return; }
  if (running) return;
  running = true; $('#go').disabled = true; $('#go span').textContent = 'COUNCIL IN SESSION…';
  $('#viewReport').classList.add('hidden'); $('#feed').innerHTML = ''; setGauge(0); setCore('0', 'INITIATING', true);
  buildRounds(Number($('#roundsSel').value)); agents.forEach((a) => setNode(a.id, 'idle'));
  sessions++; $('#tSessions').textContent = sessions;
  try {
    const res = await fetch('/api/council', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: document_, rounds: Number($('#roundsSel').value), focus: $('#focus').value,
        attachments: attachments.map((a) => ({ name: a.name, mediaType: 'application/pdf', data: a.data })),
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) { try { handle(JSON.parse(chunk.slice(6))); } catch (e) { console.error(e); } }
      }
    }
  } catch (e) { handle({ type: 'error', message: e.message }); }
  running = false; $('#go').disabled = false; $('#go span').textContent = 'CONVENE COUNCIL';
}

/* ---------- Report modal ---------- */
function showReport() { $('#reportBody').innerHTML = md(lastReport); $('#modal').classList.remove('hidden'); }
const closeReport = () => $('#modal').classList.add('hidden');
$('#viewReport').onclick = showReport;
$('#closeBtn').onclick = closeReport;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeReport(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); });
$('#copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(lastReport); $('#copyBtn').textContent = 'Copied'; setTimeout(() => ($('#copyBtn').textContent = 'Copy'), 1500); } catch { /* clipboard blocked */ } };
$('#dlBtn').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastReport], { type: 'text/markdown' }));
  a.download = `axp-council-report-${new Date().toISOString().slice(0, 10)}.md`; a.click(); URL.revokeObjectURL(a.href);
};

/* ---------- Wiring ---------- */
$('#go').onclick = run;
$('#doc').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); });
function renderAttachments() {
  $('#attachments').innerHTML = attachments.map((a, i) =>
    `<div class="att"><span title="${esc(a.name)}">📄 ${esc(a.name)}</span><small>${(a.size / 1e6).toFixed(1)} MB</small><button data-i="${i}" aria-label="Remove ${esc(a.name)}">×</button></div>`).join('');
}
$('#attachments').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  attachments.splice(Number(b.dataset.i), 1); renderAttachments();
});
const toBase64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});
async function addFiles(files) {
  for (const f of files) {
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (isPdf) {
      const total = attachments.reduce((n, a) => n + a.size, 0) + f.size;
      if (attachments.length >= MAX_PDFS) { status(`Attach at most ${MAX_PDFS} PDFs.`); continue; }
      if (f.size > MAX_PDF_BYTES) { status(`"${f.name}" is over 15 MB. Split it or export a smaller PDF.`); continue; }
      if (total > MAX_TOTAL) { status('PDFs total more than 20 MB.'); continue; }
      if (attachments.some((a) => a.name === f.name && a.size === f.size)) continue;
      try { attachments.push({ name: f.name, size: f.size, data: await toBase64(f) }); status(`Attached ${f.name}.`); }
      catch { status(`Could not read ${f.name}.`); }
    } else {
      if (f.size > 900_000) { status(`"${f.name}" is too large (900KB max for text files).`); continue; }
      $('#doc').value = await f.text(); status(`Loaded ${f.name} as text.`);
    }
  }
  renderAttachments();
}
$('#file').addEventListener('change', async (e) => { await addFiles([...e.target.files]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => $('#command').addEventListener(t, (e) => { e.preventDefault(); $('#command').classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => $('#command').addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === $('#command')) $('#command').classList.remove('drag'); }));
$('#command').addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));

(async function init() {
  try {
    const s = await (await fetch('/api/status')).json();
    agents = s.agents || []; renderNodes(); buildRounds(4);
    $('#tModel').textContent = s.model || '—';
    if (s.models?.length > 1) $('#tModel').title = s.models.join('\n');
    const chip = $('#modeChip'); chip.classList.add(s.mode);
    chip.querySelector('span').textContent = { live: 'LIVE · ONLINE', demo: 'DEMO MODE', setup: 'CHECK SETUP' }[s.mode];
    if (s.mode === 'demo') $('#hint').textContent = 'Demo mode: simulated council. Add your API key to .env for real critique.';
    if (s.mode === 'setup') {
      const why = s.configErrors ? 'Config problem: ' + s.configErrors.join(' | ') : 'Missing API key: ' + s.missingKeys.join(', ');
      $('#hint').textContent = why; status(why);
    }
  } catch {
    $('#modeChip span').textContent = 'OFFLINE';
  }
})();
