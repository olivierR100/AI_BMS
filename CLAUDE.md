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
- `GET/POST /cov` — COV profiles: effective increment, provenance and measured notif/min per
  point; `POST {action}` = `setProfile|deleteProfile|setAssignments|setOverride|preview|applyToPoints|push`

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
object + `applyConfig`), `drivers.js` (IO layer), `drivers/bacnet.js`, `cov.js`
(COV profiles), `safety.js`, `analyse.js`, `prompt.js`, `providers.js`, `tools.js`,
`logging.js`, `restore.js`. Loaded by settings.js as
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
- Modes via `POST /bms/bacnet {mode}`: `simulated` (the test server) · `real` (IP/FQDN) ·
  `disconnected` (no source, values frozen). There is **no in-memory mode**: BACnet is the
  only point source, and the tests run through it. Dashboard page `/dashboard/bacnet-server`.
  Mode persists to the file store; the flow auto-connects to the simulated server 8 s after boot.
- Physics lives only in the BACnet server — the flow has no Physics Simulator node any more.
- `Safety Guard` dispatches via `writeValueAsync` (fire-and-forget, failures land in the
  command log): a network write cannot be confirmed in the current tick.
- Values are rounded to 0.1 — BACnet REAL is a 32-bit float (21.3 → 21.299999237060547).
- Known gaps: no MS/TP (needs an IP router); no outbound segmentation, so RPM goes in batches
  of 12 and calls are serialized (the library's `_segmentStore` is not keyed by peer);
  sensors cannot be forced over BACnet — they are Analog/Binary **Inputs** by design, so the
  Sensor Simulation panel goes through the simulator's own HTTP control channel (port 47811),
  upstream of BACnet.

## COV profiles — how much traffic a point may produce
`lib/bms-core/cov.js` + `GET/POST /bms/cov`. A profile is a **sparse** unit→increment table,
not a scalar: a named profile only affects a point whose unit it defines (applying a ppm-only
profile to all 86 points touches 8). Precedence: per-point override → tag assignment (ordered
list, first match wins) → the `default` profile, which covers every unit. The resolver returns
the **provenance** with the value (`default`, `tag:meeting`, `manual`) — without it nobody can
explain why one point behaves differently from its neighbour.
- Where each setting bites: `increment` travels in the subscription request, via
  **SubscribeCOVProperty** (`covIncrement`, context tag 5). The server keeps a reference value
  per subscription, keyed by client address + subscriberProcessIdentifier + object + property,
  so our threshold never affects another supervisor — unlike writing the object's
  `COV_Increment`, which applies to every subscriber at once. Process ids are **stable per
  point**, so re-subscribing updates the record instead of stacking a second one.
  `minIntervalMs`/`heartbeatMs` have no wire representation and are enforced in the driver (the
  cap *delays* a chatty point and keeps the last value, never drops it; the heartbeat re-reads a
  point gone silent, distinguishing "nothing moved" from "the link is dead").
- The service is **optional**, so the UI adapts: the driver reads `Protocol_Services_Supported`
  at connect and publishes `capabilities.covIncrementSettable`; when false, both UIs hide the
  increment controls and show why, and the driver falls back to plain SubscribeCOV (settings
  lost, values kept). `--no-cov-property` makes the simulator play that controller.
- Two library workarounds, both commented in place — recheck on any version bump: the client's
  `subscribeProperty()` wrapper drops `covIncrement` *and* `lifetime`, so
  `lib/bms-core/drivers/cov-property.js` substitutes the library's own encoder for one call
  (with an arity check that fails loudly); `@bacnet-js/device` refuses the service and hides its
  client in a `#private` field, so `lib/bacnet-sim/server.js` swaps the client module's
  `.default` before loading the device module to capture it, and
  `lib/bacnet-sim/cov-property.js` holds the real subscription table.
  SubscribeCOVPropertyMultiple is **not** implemented: no encoder exists, and the library's
  `ServicesSupportedBitString` is 40 bits wide while the service is bit 41.
- Measured, all 13 zones converging (the worst case): 6.1 notif/s with no deadband anywhere →
  2.8/s at the 0.2 °C default (×2.2) → 1.2/s at 1.0 °C (×5.3). An idle building sits near
  0.5/s regardless, because the simulator's tick already republishes only on change — the
  roadmap's old "~20/s" was a theoretical estimate and was never real.
- Caveats: the initial notification is sent at subscribe time whatever the increment (it seeds
  the reference); and the library's decoder cannot tell `covIncrement: 0` from "absent", so the
  simulator treats 0 as absent (falls back to the object's `COV_Increment`) and notifies every
  transition for binaries.
- UI: "CoV Profiles" section on the BACnet page; Device & Tag Manager shows the effective
  increment + provenance, a sortable `notif/min` column (1 h sliding window) and bulk apply.
  `GET /covsubs` on the simulator's control port shows what the server thinks it owes whom.

## Working agreements
- All point access through the global `BMS` abstraction; config application through `BMS.applyConfig` (single seam, now in `lib/bms-core/bms.js`).
- Preserve the `bacnetPoints` (hardware) / `bmsMetadata` (BMS-side) separation — it is the future real-BACnet seam.
- Dashboard 2.0 Vue patterns: `@end` for v-slider (+`@start` to set the `editing` guard), `@change` for v-switch; `storeOutMessages` + `passthru` on emitting ui-templates.
- Never remove the conversational alignment guidelines from "Build AI Prompt (Interactive)".
- AI config, tag edits, and location settings persist to the `file` context store (`~/.node-red/context/global/global.json`, 30 s flush) and restore at boot — `default` store stays in memory (BMS object and NodeCache are not serializable).
- After any flow change: verify via `GET /bms/firelog` (or Logic Inspector) that rules load and fire.
