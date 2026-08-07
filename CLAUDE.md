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
- `GET/POST /demomode` — time speed multiplier (1/2/5/10/30/60/120, default 1 = real time). Dashboard page `/dashboard/demo-test`. Makes the 15-min occupancy hold-off demonstrable; **it survives restarts**, so check it is back at 1× before judging real behaviour.
- `GET /commandlog` — command audit trail; `?n=`, `?id=`, `?source=`, `?failed=true`

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

## Code layout — the core lives outside the flow
`lib/bms-core/` holds what used to be 75 k chars inside "Initialize System (V12)":
`points.js` (bacnetPoints/bmsMetadata/virtualPoints tables), `bms.js` (the `BMS`
object + `applyConfig`), `drivers.js` (IO layer), `safety.js`, `prompt.js`,
`providers.js`, `tools.js`, `logging.js`, `restore.js`. Loaded by settings.js as
`functionGlobalContext.bmsCore`; the flow node is now a ~30-line bootstrap.
- **Editing `lib/` requires a Node-RED restart, not just a deploy** (functionGlobalContext
  is read at startup). Editing flows.json is still deploy-only.
- `lib/` must be copied into the userDir — the installer and `build-archive.sh` do this;
  a missing `lib/` means the system does not start at all.
- Patch flows.json programmatically via `tools/flowkit.js` (validates wiring, refuses
  patches that don't bite); one-off patches are kept in `tools/patches/`.

## Tests — run them, they are the safety net
`node --test --test-concurrency=1 test/` (~4 min). `test/scenarios.test.js` drives a
throwaway Node-RED instance over HTTP (occupancy, CO2 hysteresis, setpoints, config
apply/remove, unknownFacts, demo clock); `test/unit.test.js` exercises `lib/bms-core`
directly with a fake global context, in milliseconds. Green before and after any change
to the core — the extraction was verified this way.

## Hardware seam (prep for real BACnet)
- `BMS.writeValue` stays synchronous for the 130 rules; `BMS.writeValueAsync` goes through
  the driver layer and returns `{ok, value, error}`. A point bound to a non-simulator
  driver **refuses** the sync path rather than lying about a write that hasn't happened.
- `BMS.getStatus(id)` gives `{quality, ts, ageMs, stale, source}`. Staleness is inert until
  `pointStaleAfter`/`defaultStaleAfterMs` are configured.
- Driver selection is **per point** via the `pointDrivers` context — one real controller can
  run alongside 85 simulated points.
- `bmsSafety`: command audit trail (`GET /bms/commandlog`), change-rate limiting
  (`writeRateLimit`, counts *changes* not idempotent rewrites), and an approval gate —
  a config commanding non-simulated points needs `"approved": true`.

## BACnet/IP (Tier 2 — implemented, IP only)
Two processes. `lib/bacnet-sim/server.js` is a **real BACnet/IP device** (`@bacnet-js/device`)
exposing the 86 points, running the shared physics from `lib/bacnet-sim/physics.js`; its
`object-name` **is** the fact id, which is what makes binding automatic. `bms-sim-start` /
`bms-sim-stop`. `lib/bms-core/drivers/bacnet.js` is the client (`@bacnet-js/client` 3.3.2) —
it keeps `bacnetPoints` in sync via COV subscriptions (+ periodic RPM as a net), so rules,
Control Panel and Device Manager work unchanged with no idea a network appeared underneath.
- Modes via `POST /bms/bacnet {mode}`: `internal` (in-memory, **the default**, what the tests
  and the offline demo use) · `simulated` (the test server) · `real` (IP/FQDN). Dashboard page
  `/dashboard/bacnet-server`. Mode persists to the file store.
- In non-internal mode the flow's Physics Simulator node stands down — the server owns physics.
- `Safety Guard` dispatches via `writeValueAsync` (fire-and-forget, failures land in the
  command log): a network write cannot be confirmed in the current tick.
- Values are rounded to 0.1 — BACnet REAL is a 32-bit float (21.3 → 21.299999237060547).
- Known gaps: no MS/TP (needs an IP router); no outbound segmentation, so RPM goes in batches
  of 12 and calls are serialized (the library's `_segmentStore` is not keyed by peer);
  sensors cannot be forced over BACnet — `Out_Of_Service` writes are refused by the library,
  so the Sensor Simulation panel only applies to `internal` mode.

## Working agreements
- All point access through the global `BMS` abstraction; config application through `BMS.applyConfig` (single seam, now in `lib/bms-core/bms.js`).
- Preserve the `bacnetPoints` (hardware) / `bmsMetadata` (BMS-side) separation — it is the future real-BACnet seam.
- Dashboard 2.0 Vue patterns: `@end` for v-slider (+`@start` to set the `editing` guard), `@change` for v-switch; `storeOutMessages` + `passthru` on emitting ui-templates.
- Never remove the conversational alignment guidelines from "Build AI Prompt (Interactive)".
- AI config, tag edits, and location settings persist to the `file` context store (`~/.node-red/context/global/global.json`, 30 s flush) and restore at boot — `default` store stays in memory (BMS object and NodeCache are not serializable).
- After any flow change: verify via `GET /bms/firelog` (or Logic Inspector) that rules load and fire.
