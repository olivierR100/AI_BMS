# AI BMS Project

AI-driven Building Management System on Node-RED. Architecture reference:
`handover/AI_BMS_Project_Handover.md` (note: its counts and the settings.js
key `SunCalc` are stale — trust `audit/2026-06-12_audit.md`, which supersedes
its Known Issues section; reality: 86 BACnet points, 13 zones, 17 virtual points).

## Live system
- Node-RED 4.1.1 at `http://127.0.0.1:1880` (this WSL instance), dashboard at `/dashboard/`.
- Flow source of truth: `flows.json` in this repo (tab "AI BMS V12 (Physics Simulator)") — keep live and repo in sync; deploy via Admin API `POST /flows` (full) or MCP `update-flows`.
- Admin API token: `adminAuth.tokens[0].token` in `~/.node-red/settings.js`.
- Read live global context without flow changes: `GET /context/global/<key>` (Bearer token).

## BMS HTTP API — preferred way to work with rules (no copy/paste)
Base `http://127.0.0.1:1880/bms` (no auth on localhost). Full reference incl.
config schema: `docs/BMS_CONFIG_SCHEMA.md`.
- `GET /context` — live inventory + current config (exact JSON, do minimal diffs)
- `POST /config` — apply config; response reports `unknownFacts` (fix them, they mean dead rules)
- `GET /firelog` — verify rules load AND fire (never declare success on apply alone)
- `GET/POST /points` — read facts; write via BMS layer; `"simulate": true` overrides raw sensors
- `GET /syslog` — rolling runtime log (node warn/error/info); `?n=`, `?level=`, `?grep=` (server-side debug aid; not browser/client issues)

Slash commands: `/bms-status`, `/bms-apply <request>`, `/bms-debug <symptom>`, `/bms-simulate <scenario>`.

## In-dashboard AI assistant (Track 2) — multi-provider
Dashboard page `/dashboard/ai-assistant`: end-user chat → LLM with the `apply_bms_config` tool
→ `BMS.applyConfig`. Supports **Anthropic / OpenAI / DeepSeek** via a provider-adapter layer in
Initialize System (`aiProviders`, `aiBuildRequest`, `aiParseResponse`; neutral internal history
translated per provider — `style: 'anthropic'` vs `'openai'` where DeepSeek reuses the OpenAI
format). Settings in `aiChatSettings` = `{provider, keys:{...}, models:{...}}` (file-store
persisted; keys deliberately visible/erasable per-provider in the UI — erase before transferring).
Shared prompt builder: global `buildAIPrompt('paste'|'tool')` in Initialize System — the
alignment guidelines live there now; the non-negotiable "never remove them" rule applies to it.

## Working agreements
- All point access through the global `BMS` abstraction; config application through `BMS.applyConfig` (single seam, defined in "Initialize System (V12)").
- Preserve the `bacnetPoints` (hardware) / `bmsMetadata` (BMS-side) separation — it is the future real-BACnet seam.
- Dashboard 2.0 Vue patterns: `@end` for v-slider (+`@start` to set the `editing` guard), `@change` for v-switch; `storeOutMessages` + `passthru` on emitting ui-templates.
- Never remove the conversational alignment guidelines from "Build AI Prompt (Interactive)".
- AI config, tag edits, and location settings persist to the `file` context store (`~/.node-red/context/global/global.json`, 30 s flush) and restore at boot — `default` store stays in memory (BMS object and NodeCache are not serializable).
- After any flow change: verify via `GET /bms/firelog` (or Logic Inspector) that rules load and fire.
