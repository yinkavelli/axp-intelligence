// The Council: specialist agents critique a document in parallel, an orchestrator
// synthesizes each round into a revised draft, and after N (>= 4) rounds it issues
// a final verdict.

export const AGENTS = [
  {
    id: 'strategist', name: 'Strategist', role: 'Objectives & positioning',
    system: 'You are the Strategist on a business review council for Axinity Partners. Judge whether the document achieves its goal for its audience: clarity of the ask, positioning, value proposition, persuasiveness, and what is missing strategically.',
  },
  {
    id: 'skeptic', name: 'Skeptic', role: 'Red team & logic',
    system: 'You are the Skeptic on a business review council for Axinity Partners. Attack the document: find weak arguments, unsupported claims, logical gaps, unrealistic assumptions, and questions a hostile reader would raise.',
  },
  {
    id: 'editor', name: 'Editor', role: 'Clarity & tone',
    system: 'You are the Editor on a business review council for Axinity Partners. Judge structure, concision, tone, consistency and readability. Point to specific passages that should be cut, reordered or rewritten.',
  },
  {
    id: 'risk', name: 'Risk & Compliance', role: 'Legal, financial, reputation',
    system: 'You are the Risk & Compliance officer on a business review council for Axinity Partners. Flag legal, financial, contractual, reputational and data-privacy exposure, risky commitments, missing caveats, and numbers or dates that need verification. You are not a lawyer; flag items for professional review.',
  },
];

const MODEL = () => process.env.AXP_MODEL || 'claude-sonnet-5-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callClaude({ system, user, maxTokens = 1500 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        // Only needed when the key isn't scoped to a single workspace
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
    if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
}

function parseScore(text) {
  const m = text.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return m ? Math.min(10, Number(m[1])) : null;
}
const stripScore = (t) => t.replace(/\n*SCORE:\s*\d+(?:\.\d+)?\s*\/\s*10\s*$/i, '').trim();

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function agentCritique(agent, { draft, round, rounds, focus, priorIssues }) {
  const user = [
    `Review round ${round} of ${rounds}.`,
    focus ? `The requester's focus: ${focus}` : '',
    priorIssues.length ? `Issues still open from the previous round:\n${priorIssues.map((i) => `- ${i}`).join('\n')}\nCheck whether the current draft resolved them, then look for NEW problems.` : 'This is the first pass: give your most important findings.',
    `\n<document>\n${draft}\n</document>`,
    '\nRespond with 3-5 short, specific, actionable bullet points (max 180 words total), prioritised most important first. Quote or reference the exact passage when you can. End with a final line exactly in the form "SCORE: X/10" rating the document from your specialty\'s perspective.',
  ].filter(Boolean).join('\n');
  const text = await callClaude({ system: agent.system, user, maxTokens: 700 });
  return { text: stripScore(text), score: parseScore(text) };
}

async function orchestrate({ draft, critiques, round, rounds, focus }) {
  const system = 'You are the Orchestrator of a business review council for Axinity Partners. You receive the current document and critiques from four specialists. Resolve conflicts between them, apply the changes that clearly improve the document, and keep the author\'s voice and facts. Never invent facts, figures or names; where information is missing insert a [TO CONFIRM: ...] marker instead.';
  const user = [
    `Round ${round} of ${rounds}.`,
    focus ? `Requester's focus: ${focus}` : '',
    `<current_document>\n${draft}\n</current_document>`,
    ...critiques.map((c) => `<critique from="${c.name}" score="${c.score ?? 'n/a'}">\n${c.text}\n</critique>`),
    '\nReturn ONLY a JSON object with keys: "revised_document" (string, the full improved document), "consensus_score" (number 0-100, how close the document is to ready), "round_summary" (string, 1-2 sentences on what changed and why), "open_issues" (array of up to 5 short strings still unresolved).',
  ].filter(Boolean).join('\n\n');
  const text = await callClaude({ system, user, maxTokens: 6000 });
  const j = parseJson(text);
  if (j && typeof j.revised_document === 'string') {
    return {
      draft: j.revised_document,
      score: Math.max(0, Math.min(100, Number(j.consensus_score) || 0)),
      summary: String(j.round_summary || ''),
      openIssues: Array.isArray(j.open_issues) ? j.open_issues.map(String).slice(0, 5) : [],
    };
  }
  // Model didn't return clean JSON: keep the draft, surface the text as the summary.
  return { draft, score: 0, summary: text.slice(0, 400), openIssues: [] };
}

async function finalize({ original, draft, history, rounds, focus }) {
  const system = 'You are the Orchestrator of a business review council for Axinity Partners, delivering the final response to the principal. Be direct, concrete and concise. Use Markdown.';
  const user = [
    focus ? `Requester's focus: ${focus}` : '',
    `The council completed ${rounds} rounds. Round-by-round summaries:\n${history.map((h) => `Round ${h.round}: ${h.summary}`).join('\n')}`,
    `<original_document>\n${original}\n</original_document>`,
    `<final_draft>\n${draft}\n</final_draft>`,
    'Write the final report with exactly these sections:\n## Verdict\n(2-3 sentences: is it ready, and the single biggest improvement)\n## Key Findings\n(5-7 bullets, the most important issues the council found and how they were handled)\n## Remaining Risks\n(bullets; items needing human verification, including any [TO CONFIRM] markers)\n## Final Document\n(the complete final draft)',
  ].filter(Boolean).join('\n\n');
  return callClaude({ system, user, maxTokens: 8000 });
}

// ---------- Demo mode (no API key): simulated council so the UI can be explored ----------
const DEMO = {
  strategist: [
    ['The core ask is buried in paragraph three. Lead with the outcome you want from the reader.', 'Value proposition is generic; tie it to a measurable result for this specific audience.', 'No clear next step or call to action at the close.'],
    ['Opening is stronger. The benefit claims still need one concrete proof point.', 'Differentiation versus alternatives is implied, not stated.', 'Call to action is present but competes with two other asks.'],
    ['Positioning now lands. Consider a one-line summary the reader can forward.', 'Audience fit is good; trim internal jargon.'],
    ['Strategically sound. Only polish remains.', 'Confirm the call to action matches the intended decision-maker.'],
  ],
  skeptic: [
    ['Several claims are asserted without evidence. A sceptical reader will ask "compared to what?"', 'The timeline assumes no dependencies slip.', 'The argument in the middle section skips a step: cost is discussed before value is established.'],
    ['Evidence added, but one statistic has no source.', 'The timeline still ignores resourcing risk.'],
    ['Objections are mostly pre-empted. One remaining assumption about adoption rate is optimistic.'],
    ['No major logical gaps remain. Flag the adoption assumption explicitly as an assumption.'],
  ],
  editor: [
    ['Paragraphs run long; split at natural topic changes.', 'Tone shifts from formal to casual midway; pick one.', 'Repeated phrasing in the second half; cut roughly 15%.'],
    ['Flow is much better. Headings would help scanning.', 'A few sentences still open with filler ("It is important to note").'],
    ['Consistent tone now. Tighten the closing paragraph.'],
    ['Clean and concise. Final proofread for punctuation consistency.'],
  ],
  risk: [
    ['Commitments on dates and deliverables read as guarantees; soften or add conditions.', 'Figures need verification against source records.', 'No confidentiality or data-handling language where client data is mentioned.'],
    ['Guarantee language reduced. Pricing terms remain ambiguous, so route to counsel.', 'One figure is still unverified.'],
    ['Exposure is much lower. Confirm the liability wording with a professional.'],
    ['Acceptable residual risk. Verify all [TO CONFIRM] items before sending.'],
  ],
};

async function demoCouncil({ document, rounds, focus, emit, isAborted }) {
  let draft = document;
  const history = [];
  for (let r = 1; r <= rounds; r++) {
    if (isAborted()) return;
    emit('round_start', { round: r, rounds });
    await Promise.all(AGENTS.map(async (a, i) => {
      emit('agent_start', { agent: a.id, round: r });
      await sleep(1400 + i * 450 + Math.random() * 700);
      const set = DEMO[a.id][Math.min(r - 1, 3)];
      const score = Math.min(9.4, 5.2 + r * 0.9 + Math.random() * 0.6);
      emit('agent_done', { agent: a.id, round: r, text: set.map((s) => `- ${s}`).join('\n'), score: Math.round(score * 10) / 10 });
    }));
    if (isAborted()) return;
    emit('synth_start', { round: r });
    await sleep(1500);
    const score = Math.min(96, 38 + r * (54 / rounds) + Math.random() * 4);
    const summary = `Demo mode: round ${r} findings merged (simulated). Add an API key for real agent critique.`;
    history.push({ round: r, summary });
    emit('synth_done', { round: r, score: Math.round(score), summary, openIssues: r < rounds ? ['Simulated open issue: verify figures', 'Simulated open issue: tighten close'] : [] });
  }
  emit('finalizing');
  await sleep(1400);
  const report = `## Verdict\nThis is a **demo-mode** result: no live agents ran, so nothing below is a real critique of your document. Add \`ANTHROPIC_API_KEY\` to \`.env\` and restart to convene the real council.\n\n## Key Findings\n- The council loop ran ${rounds} rounds with four specialists (Strategist, Skeptic, Editor, Risk & Compliance).\n- Each round ends with the Orchestrator merging critiques into a revised draft.\n- In live mode, findings reference specific passages of your document.\n\n## Remaining Risks\n- Everything here is simulated. Do not rely on it.\n\n## Final Document\n${draft}`;
  emit('final', { report, mode: 'demo' });
}

export async function runCouncil({ document, rounds, focus, emit, isAborted }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    emit('start', { rounds, mode: 'demo', agents: AGENTS.map(({ id, name, role }) => ({ id, name, role })) });
    return demoCouncil({ document, rounds, focus, emit, isAborted });
  }
  emit('start', { rounds, mode: 'live', agents: AGENTS.map(({ id, name, role }) => ({ id, name, role })) });

  let draft = document;
  let openIssues = [];
  const history = [];
  for (let round = 1; round <= rounds; round++) {
    if (isAborted()) return;
    emit('round_start', { round, rounds });
    const critiques = await Promise.all(AGENTS.map(async (a) => {
      emit('agent_start', { agent: a.id, round });
      const { text, score } = await agentCritique(a, { draft, round, rounds, focus, priorIssues: openIssues });
      emit('agent_done', { agent: a.id, round, text, score });
      return { name: a.name, text, score };
    }));
    if (isAborted()) return;
    emit('synth_start', { round });
    const out = await orchestrate({ draft, critiques, round, rounds, focus });
    draft = out.draft; openIssues = out.openIssues;
    history.push({ round, summary: out.summary });
    emit('synth_done', { round, score: out.score, summary: out.summary, openIssues });
  }
  if (isAborted()) return;
  emit('finalizing');
  const report = await finalize({ original: document, draft, history, rounds, focus });
  emit('final', { report, mode: 'live' });
}
