// Provider adapters. Two formats cover nearly every vendor:
//   anthropic  -> Anthropic Messages API
//   openai     -> OpenAI-style /chat/completions (OpenAI, OpenRouter, Ollama, Mistral, Gemini's compat endpoint, ...)
import { resolveModel } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY = [429, 500, 502, 503, 529];

// Accumulates token usage across a run for the cost readout.
export class Meter {
  constructor() { this.by = new Map(); this.calls = 0; }
  add(model, inTok, outTok) {
    const m = this.by.get(model) || { model, in: 0, out: 0, calls: 0 };
    m.in += inTok || 0; m.out += outTok || 0; m.calls++; this.calls++;
    this.by.set(model, m);
  }
  summary(pricing = {}) {
    const byModel = [...this.by.values()].map((m) => {
      const p = pricing[m.model];
      return { ...m, usd: p ? (m.in * p.in + m.out * p.out) / 1e6 : null };
    });
    return {
      calls: this.calls,
      inTokens: byModel.reduce((n, m) => n + m.in, 0), outTokens: byModel.reduce((n, m) => n + m.out, 0),
      usd: byModel.reduce((n, m) => n + (m.usd || 0), 0),
      unpriced: byModel.filter((m) => m.usd === null).map((m) => m.model), byModel,
    };
  }
}

async function post(url, headers, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if (RETRY.includes(res.status) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw).error.message; } catch { /* keep raw */ }
    throw new Error(`${new URL(url).hostname} ${res.status}: ${msg}`);
  }
}

async function anthropic(r, { system, user, maxTokens }) {
  const p = r.provider;
  const extra = {};
  for (const [header, env] of Object.entries(p.headersFromEnv || {})) if (process.env[env]) extra[header] = process.env[env];
  const body = { model: r.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  if (r.effort) body.output_config = { effort: r.effort };
  const data = await post(`${p.baseUrl.replace(/\/+$/, '')}/v1/messages`,
    { 'x-api-key': process.env[p.apiKeyEnv], 'anthropic-version': '2023-06-01', ...extra }, body);
  if (data.stop_reason === 'refusal') throw new Error(`${r.model} declined to process this content (safety refusal).`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text && data.stop_reason === 'max_tokens') throw new Error(`${r.model} hit its token limit before writing any text. Set a lower "effort" for it in config/council.json.`);
  return { text, inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens };
}

async function openai(r, { system, user, maxTokens }) {
  const p = r.provider;
  if (Array.isArray(user)) {
    if (user.some((b) => b.type !== 'text')) throw new Error(`Provider "${r.providerName}" cannot read PDFs. Use an Anthropic model for roles.intake.`);
    user = user.map((b) => b.text).join('\n');
  }
  const data = await post(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    { authorization: `Bearer ${process.env[p.apiKeyEnv]}`, ...(p.headers || {}) },
    { model: r.model, [p.maxTokensParam || 'max_tokens']: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const choice = data.choices?.[0];
  const text = String(choice?.message?.content || '').trim();
  if (choice?.finish_reason === 'content_filter') throw new Error(`${r.model} blocked this content (content filter).`);
  if (!text && choice?.finish_reason === 'length') throw new Error(`${r.model} hit its token limit before writing any text.`);
  return { text, inTok: data.usage?.prompt_tokens, outTok: data.usage?.completion_tokens };
}

// Resolve a model reference (alias or provider:model) and run one completion.
export async function complete(cfg, ref, args, meter) {
  const r = resolveModel(cfg, ref);
  const out = await (r.provider.type === 'anthropic' ? anthropic : openai)(r, args);
  meter?.add(r.model, out.inTok, out.outTok);
  return out.text;
}
