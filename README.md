# AXP Intelligence

A Jarvis-style command center for Axinity Partners. First mission: **Council Critique**.

Paste a document and four specialist agents (Strategist, Skeptic, Editor, Risk & Compliance) review it in
parallel. An Orchestrator merges their critiques into a revised draft, then the loop repeats: **at least 4
rounds** (you can pick 4, 5, 6 or 8). After the last round the Orchestrator returns a final report with a
verdict, key findings, remaining risks and the finished document. Progress streams live to the dashboard.

## How a run works (and where tokens go)

1. **Preflight**: a small, cheap model (Haiku) checks that the brief doesn't rely on material you didn't provide (for example "the attached deck" with nothing attached). If so, the run stops immediately and nothing else is spent.
2. **Intake**: any PDFs (up to 3, 15 MB each) are read **once** into a text digest. Charts and images are described in words.
3. **Council**: rounds of 4 specialists plus the Orchestrator work from the digest, so the PDF is never re-sent on every call.
4. **Final report** from the Orchestrator.

If you attach a PDF and paste no text, the PDF's content itself is what gets reviewed.

## Run

```bash
cp .env.example .env      # then put your key in .env (not in .env.example)
npm start                 # http://localhost:3000
```

No dependencies to install (Node 20+). Without a key it runs in **demo mode** with a simulated council.
If you see `This API key is not scoped to a workspace`, set `ANTHROPIC_WORKSPACE_ID` in `.env` (or create the key inside a specific workspace).

## Choosing models and agents (no code)

Everything lives in **`config/council.json`**. It is re-read on every run, so edits apply immediately without a restart.

- **`models`**: named aliases. The shipped config has `fast` (Haiku, used for the cheap preflight check) and `main` (Sonnet, with `effort: medium` to control thinking cost). Change the model id on the `main` line and the whole council moves.
- **`agents`**: up to 4. Each has a name, role, colour, `system` prompt (the persona) and a `model`. Give one agent a different model to mix vendors, e.g. `"model": "openai:<model-id>"`.
- **`roles`**: which model does `preflight`, `intake` (PDF reading, must be an Anthropic model) and `orchestrator`.
- **`providers`**: how to reach each vendor. Two types cover nearly everything: `anthropic`, and `openai` (any OpenAI-compatible `/chat/completions` API: OpenAI, OpenRouter, Ollama, Mistral, Gemini's compatible endpoint…). To add one, copy the `openai` block, change `baseUrl` and `apiKeyEnv`, then add that key to `.env`.
- **`pricing`**: dollars per million tokens, used only for the cost estimate shown after each run. Models you don't list show tokens but no price.

A model reference is either an alias (`"main"`) or `provider:model-id` (`"openai:<model-id>"`). Remove `effort` for models that don't support it.

Confidentiality: every provider an agent uses receives your document. Check each vendor's data terms before using sensitive material.

## How a run works (and where tokens go)

1. **Preflight**: a small, cheap model checks that the brief doesn't rely on material you didn't provide (for example "the attached deck" with nothing attached). If so, the run stops immediately and nothing else is spent.
2. **Intake**: any PDFs (up to 3, 15 MB each) are read **once** into a text digest. Charts and images are described in words.
3. **Council**: rounds of specialists plus the Orchestrator work from the digest, so the PDF is never re-sent on every call. Minimum 4 rounds.
4. **Final report**: the model writes only the verdict, findings and risks; the final document is appended verbatim rather than being regenerated.

If you attach a PDF and paste no text, the PDF's content itself is what gets reviewed. Token counts and an estimated cost are shown after every run.

## Layout

- `council.js`: preflight, intake, round loop, orchestrator, demo mode.
- `config.js` / `llm.js`: config loading and validation; provider adapters and the token meter.
- `config/council.json`: models, providers and agents (edit this, not code).
- `server.js`: static server + `POST /api/council` (server-sent events).
- `public/`: dashboard (HTML/CSS/JS, no build).

## Adding missions

The sidebar lists Inbox Triage, Meeting Brief and Market Scan as standby placeholders. New missions follow the
same pattern: a function that emits events, plus an endpoint.

Note: the API key stays on the server; the browser never sees it. There is no login, so run this locally or
put it behind authentication before exposing it.
