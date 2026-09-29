// Loads and validates config/council.json. Re-read on every run so edits apply without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGENTS = 4; // the dashboard has four orbit slots
const ROLES = ['preflight', 'intake', 'orchestrator'];

export function loadConfig() {
  const file = process.env.AXP_CONFIG || path.join(__dirname, 'config', 'council.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`Cannot read ${file}`); }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`config/council.json is not valid JSON: ${e.message}`); }
}

// "provider:model-id" (split on the FIRST colon so ids like "llama3:8b" survive) or an alias from cfg.models.
export function resolveModel(cfg, ref, seen = new Set()) {
  if (typeof ref !== 'string' || !ref) throw new Error('Missing model reference');
  const alias = cfg.models?.[ref];
  if (alias !== undefined) {
    if (seen.has(ref)) throw new Error(`Model alias loop at "${ref}"`);
    seen.add(ref);
    const o = typeof alias === 'string' ? { use: alias } : alias;
    const r = resolveModel(cfg, o.use, seen);
    return { ...r, effort: o.effort ?? r.effort };
  }
  const i = ref.indexOf(':');
  if (i < 1) throw new Error(`"${ref}" is neither a model alias nor "provider:model-id"`);
  const providerName = ref.slice(0, i), model = ref.slice(i + 1);
  const provider = cfg.providers?.[providerName];
  if (!provider) throw new Error(`Unknown provider "${providerName}" in "${ref}"`);
  return { ref, providerName, provider, model, effort: undefined };
}

export function validateConfig(cfg) {
  const errs = [];
  const check = (label, ref) => {
    try {
      const r = resolveModel(cfg, ref);
      if (!['anthropic', 'openai'].includes(r.provider.type)) errs.push(`Provider "${r.providerName}" has unknown type "${r.provider.type}" (use "anthropic" or "openai")`);
      if (!r.provider.baseUrl || !r.provider.apiKeyEnv) errs.push(`Provider "${r.providerName}" needs baseUrl and apiKeyEnv`);
      return r;
    } catch (e) { errs.push(`${label}: ${e.message}`); }
  };
  for (const role of ROLES) check(`roles.${role}`, cfg.roles?.[role]);
  const agents = cfg.agents;
  if (!Array.isArray(agents) || agents.length < 2 || agents.length > MAX_AGENTS) errs.push(`"agents" must list 2 to ${MAX_AGENTS} agents`);
  else {
    const ids = new Set();
    for (const a of agents) {
      for (const k of ['id', 'name', 'role', 'system', 'model']) if (!a[k]) errs.push(`Agent "${a.id || a.name || '?'}" is missing "${k}"`);
      if (ids.has(a.id)) errs.push(`Duplicate agent id "${a.id}"`);
      ids.add(a.id);
      if (a.model) check(`agent "${a.id}"`, a.model);
    }
  }
  // Only Claude can read PDFs natively here, so intake must use an Anthropic-type provider.
  try { if (resolveModel(cfg, cfg.roles?.intake).provider.type !== 'anthropic') errs.push('roles.intake must use an Anthropic model (it is the only step that reads PDFs)'); } catch { /* reported above */ }
  return errs;
}

// Providers actually referenced by roles/agents, and whether their keys are set.
export function keyStatus(cfg) {
  const refs = [...ROLES.map((r) => cfg.roles?.[r]), ...(cfg.agents || []).map((a) => a.model)];
  const used = new Map();
  for (const ref of refs) { try { const r = resolveModel(cfg, ref); used.set(r.providerName, r.provider.apiKeyEnv); } catch { /* validated elsewhere */ } }
  const missing = [...used].filter(([, env]) => !process.env[env]).map(([provider, env]) => ({ provider, env }));
  return { missing, anyKey: missing.length < used.size };
}

export const agentList = (cfg) => cfg.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, color: a.color || '#4de1ff', model: resolveModel(cfg, a.model).model }));
export function modelSummary(cfg) {
  const ids = [...new Set([...ROLES.map((r) => cfg.roles[r]), ...cfg.agents.map((a) => a.model)].map((ref) => resolveModel(cfg, ref).model))];
  return { label: ids.length === 1 ? ids[0] : `${ids.length} models`, ids };
}
