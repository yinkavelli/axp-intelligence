# AXP Intelligence

A Jarvis-style command center for Axinity Partners. First mission: **Council Critique**.

Paste a document and four specialist agents (Strategist, Skeptic, Editor, Risk & Compliance) review it in
parallel. An Orchestrator merges their critiques into a revised draft, then the loop repeats: **at least 4
rounds** (you can pick 4, 5, 6 or 8). After the last round the Orchestrator returns a final report with a
verdict, key findings, remaining risks and the finished document. Progress streams live to the dashboard.

## Run

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY for live agents
npm start                 # http://localhost:3000
```

No dependencies to install (Node 20+). Without an API key it runs in **demo mode** with a simulated council so
you can explore the UI. Default model is `claude-sonnet-5-5`; override with `AXP_MODEL`.

## Layout

- `council.js`: agents, round loop, orchestrator, demo mode. Add or edit agents in the `AGENTS` array.
- `server.js`: static server + `POST /api/council` (server-sent events).
- `public/`: dashboard (HTML/CSS/JS, no build).

## Adding missions

The sidebar lists Inbox Triage, Meeting Brief and Market Scan as standby placeholders. New missions follow the
same pattern: a function that emits events, plus an endpoint.

Note: the API key stays on the server; the browser never sees it. There is no login, so run this locally or
put it behind authentication before exposing it.
