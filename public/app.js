// AXP Intelligence front end: no build step, no dependencies.
const $ = (s) => document.querySelector(s);
const COLORS = { strategist: '#4de1ff', skeptic: '#ff6b81', editor: '#8b7bff', risk: '#ffc857' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let agents = [];
let lastReport = '';
let sessions = 0;
let running = false;
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
const NODE_POS = { strategist: [300, 36], skeptic: [564, 300], risk: [300, 564], editor: [36, 300] };
function buildLinks() {
  $('#links').innerHTML = Object.entries(NODE_POS).map(([id, [x, y]]) =>
    `<line class="link" id="link-${id}" x1="300" y1="300" x2="${x}" y2="${y}" style="--cx:${COLORS[id]}"/>`).join('');
}
function renderNodes() {
  document.querySelectorAll('.node').forEach((n) => {
    const a = agents.find((x) => x.id === n.dataset.agent);
    if (!a) return;
    n.innerHTML = `<div class="n-name">${esc(a.name)}</div><div class="n-role">${esc(a.role)}</div>
      <div class="n-state"><i></i><span>Idle</span></div><div class="n-score"></div>`;
  });
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
      feed('agent', `${a?.name || ev.agent}${ev.score != null ? ' · ' + ev.score.toFixed(1) + '/10' : ''}`, ev.text, COLORS[ev.agent]);
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
    case 'error':
      feed('err', 'Error', ev.message); status('Council interrupted: ' + ev.message); setCore('!', 'ERROR', false); break;
  }
}

async function run() {
  const document_ = $('#doc').value.trim();
  if (document_.length < 20) { status('Paste a document first (at least 20 characters).'); $('#doc').focus(); return; }
  if (running) return;
  running = true; $('#go').disabled = true; $('#go span').textContent = 'COUNCIL IN SESSION…';
  $('#viewReport').classList.add('hidden'); $('#feed').innerHTML = ''; setGauge(0); setCore('0', 'INITIATING', true);
  sessions++; $('#tSessions').textContent = sessions;
  try {
    const res = await fetch('/api/council', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: document_, rounds: Number($('#roundsSel').value), focus: $('#focus').value }),
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
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 900_000) { status('File too large (900KB max).'); return; }
  $('#doc').value = await f.text(); status(`Loaded ${f.name}.`);
});

(async function init() {
  buildLinks();
  try {
    const s = await (await fetch('/api/status')).json();
    agents = s.agents; renderNodes(); buildRounds(4);
    $('#tModel').textContent = s.mode === 'live' ? s.model : 'simulated';
    const chip = $('#modeChip'); chip.classList.add(s.mode);
    chip.querySelector('span').textContent = s.mode === 'live' ? 'LIVE · ONLINE' : 'DEMO MODE';
    if (s.mode === 'demo') $('#hint').textContent = 'Demo mode: simulated council. Add ANTHROPIC_API_KEY to .env for real critique.';
  } catch {
    $('#modeChip span').textContent = 'OFFLINE';
  }
})();
