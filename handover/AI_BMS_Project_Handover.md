# AI-Driven BMS — Project Handover & Technical Recap

**Version:** V12.1 (Physics Simulator + BMS API) — flow source of truth: `flows.json` in the git repo
**Author:** Olivier — **Handover date:** June 2026 — **Last revised:** 2026-06-12 (post-audit: P0/P1 fixes + Track 1 BMS API)
**Purpose of this document:** enable a new AI instance (Claude Code) and other engineers to take over the project without loss of context.

> **Companion documents:** `audit/2026-06-12_audit.md` (full audit; supersedes §8 history),
> `docs/BMS_CONFIG_SCHEMA.md` (canonical AI-config schema + HTTP API reference),
> `CLAUDE.md` (session workflow for Claude Code).

---

## 1. Project Intent

Replace the complex, static configuration interfaces of traditional Building Management Systems (Niagara, EcoStruxure…) with a **Generative AI workflow**:

1. **Context export** — the system serializes its full state (hardware inventory, tags, virtual points, active rules, dashboard layout) into a system prompt.
2. **Natural language** — the user describes the desired automation ("Turn off heating if the window is open for 10 minutes").
3. **JSON generation** — the LLM engages in a conversational dialogue, then (only when the user confirms with "ready"/"generate") emits one JSON configuration object.
4. **Hot-reload** — Node-RED sanitizes, validates, and applies the JSON to its global context. The rules engine and dashboard update instantly, no restart.

The current pain point (and goal of the next phase): the prompt and the JSON are exchanged by **manual copy-paste** between the Node-RED dashboard and a chat window. The restart goal is to make the AI interaction happen **directly inside the browser dashboard** (see §10).

---

## 2. Work Environment Installation

### 2.1 Platform
- Windows 11 + **WSL2** (Ubuntu). Use the Microsoft **Terminal** app (better CTRL-C/V handling across Windows/Linux).
- Node.js LTS (18+ recommended; check Node-RED's current requirement) inside WSL.

### 2.2 Node-RED
```bash
# inside WSL
sudo npm install -g --unsafe-perm node-red
cd ~/.node-red
```

### 2.3 npm dependencies (CRITICAL — hidden in settings.js)
The flow export does **not** carry all dependencies. Two categories:

**A. Palette nodes** (declared in the flow's `global-config` node, auto-prompted on import):
| Package | Version in export |
|---|---|
| `@flowfuse/node-red-dashboard` (Dashboard 2.0) | 1.30.0 |
| `node-red-node-openweathermap` | 1.0.1 |

**B. Function-context modules** (NOT in the flow — must be installed manually and declared in `~/.node-red/settings.js`):
```bash
cd ~/.node-red
npm install json-rules-engine node-cache suncalc
```
Then in `settings.js` (key names must match EXACTLY — a doc/settings mismatch on the
suncalc key once left sun position dead for months):
```js
functionGlobalContext: {
    jsonRulesEngine: require('json-rules-engine'),
    nodeCacheModule: require('node-cache'),
    suncalcModule: require('suncalc')
}
```
The flow accesses these via `global.get('jsonRulesEngine')`, `global.get('nodeCacheModule')`, `global.get('suncalcModule')`. **If settings.js is not configured, the Logic Kernel and State Manager crash on first tick.**

**C. Context storage (REQUIRED since V12.1)** — persistence of AI config/tag edits/location:
```js
contextStorage: {
    default: { module: "memory" },   // BMS object + NodeCache are not serializable
    file: { module: "localfilesystem" }
}
```
The repo's `settings.js` already contains both B and C.

> **Recommended upgrade:** migrate these three to per-node module declarations (the "Setup" tab of function nodes / `functionExternalModules: true`). This makes the flow import fully self-contained and removes the settings.js trap. See §9.

### 2.4 Secrets
- **OpenWeatherMap API key** — configured in the `OpenWeatherMap` node credentials. Credentials are **not exported** in flows.json; the key must be re-entered after import (node `weather_owm`, group *WEATHER INTEGRATION*).

### 2.5 Run procedure
```bash
cd ~/.node-red
rm flows.json            # clean slate before importing a full export
node-red
```
- Editor: `http://127.0.0.1:1880/`
- Import the flow JSON (Menu → Import), Deploy.
- Press the **Boot System** inject node (or redeploy) to run `Initialize System (V12)`.
- Dashboard: `http://localhost:1880/dashboard/` (pages listed in §6).

---

## 3. Node-RED Flow Architecture (V12.1)

One tab: **"AI BMS V12 (Physics Simulator)"**, 100 nodes organized into 11 visual groups. Names below match the Node-RED UI exactly.

### 3.1 Bootstrap (ungrouped)
- **Boot System** (inject, fires on deploy) → **Initialize System (V12)** (function): defines `bacnetPoints` (86 points, 13 zones incl. External, 3 floors), `bmsMetadata` (tags + zones), `virtualPoints` (17), and the **BMS abstraction layer** (global `BMS` object, incl. `applyConfig`). On boot it restores persisted AI config / tag edits / location from the `file` context store; on redeploy it preserves current runtime values (precedence: defaults < persisted < runtime).

### 3.2 LOGIC KERNEL (the brain — 1 s loop)
| Node | Role |
|---|---|
| **1s Heartbeat** (inject) | Drives the loop every second. |
| **Build Facts** (function) | `BMS.getValues()` (all BACnet + virtual point values) merged with soft states from `myStateCache` (falling back to `defaultValue`). Output: flat fact object. |
| **JSON Rules Engine** (function) | Instantiates `json-rules-engine`, registers **custom operators** (`lessThanFact`, `greaterThanFact`, `equalFact`, `lessThanInclusiveFact`, …) implemented as promise-based `almanac.factValue()` comparisons with defensive checks. Loads `ruleGroups`, runs facts, emits events. Maintains `ruleFireLog` for the inspector. |
| **Event Router** (switch) | `set_state` → State Manager; `control_device`/`control_group` → Group Resolver. |
| **State Manager** (function) | Writes soft states into `myStateCache` (NodeCache) with TTL; supports `value`, `value_from_fact`, and `value_expr` arithmetic (add/subtract/multiply/divide/min/max/round). |
| **Group Resolver** (function) | Expands `control_group` (tag-based, unit-aware, actuator-only filtering) into per-device writes. |
| **Safety Guard** (function) | Final gateway: clamps to `min`/`max`, rejects writes to `read_only` points, then `BMS.writeValue()`. |
| **Update time** (function) | Refreshes time-related virtual points. |

### 3.3 PHYSICS SIMULATOR (removable)
- **Physics ~2s** (inject) → **Physics Simulator** (function).
- Gated by virtual point `physics_enabled` (set `false` to disable without deleting; node status shows "Disabled").
- **Dynamic zone discovery**: builds zones from `bmsMetadata` tags (no hardcoded room list). Behaviors: room temperature drifts toward setpoint and outside temperature; lux responds to lamp state + outside lux; CO2 rises with occupancy/motion and falls with ventilation.
- Designed to be deleted as a group when connecting real hardware.

### 3.4 DASHBOARD ENGINE
- **Merge Config + Data** (function): merges `dashboardConfig` (AI-generated layout) with live values.
- **Dynamic Widget Renderer** (ui-template, Vue.js): generic renderer looping over the widget list; renders text/slider/switch/groups by `type`.
- **Filter User Input** (function): routes user widget interactions back into `BMS.writeValue()`.
- Vue gotchas (hard-won): use `@end` on `v-slider` and `@change` on `v-switch` (not `@update:model-value`); `storeOutMessages` and `passthru` must be enabled on ui-template nodes for downstream messaging.

### 3.5 AI CONFIGURATION
- **Generate Prompt** (ui-button) → **Build AI Prompt (Interactive)** (function): assembles the full system prompt — categorized point inventory (sensors/actuators/weather with tags, units, min–max), virtual points (time/sun/location/config), tag list with counts, **exact JSON of the current configuration**, schema reference, operators, event types, widget catalog, and **alignment/interaction guidelines** (conversational first; JSON only on user "ready"/"generate"). ~15 kB, token-optimized.
- **Prompt Display** (ui-template): shows prompt + clipboard copy.
- **Import Panel** (ui-template) → **Parse & Apply** (function): the defense layer — strips CRLF, comments, trailing commas, non-breaking spaces and smart quotes; extracts JSON from ```` ```json ```` fences or brace-matching; applies each present section (`behavior_agents`, `rule_groups`, `defined_states`, `dashboard`) to global context; emits a **Toast** (ui-notification) with a summary or error.

### 3.6 BEHAVIOR AGENTS UI (Logic Inspector)
- **Refresh** (button) + **Auto** (inject, 2 s) → **Build View** → **Inspector** (ui-template): lists agents/rule groups with enable state, categories, and fire counts from `ruleFireLog` — proof that the AI's logic actually loaded and runs.
- **Timer countdown (2026-06-15):** Build View detects timer states structurally (any state written via `set_state` from `glob_time_minute_of_week`) and computes `remainingSeconds`; the Inspector renders a **live countdown** that ticks locally every 1 s and re-anchors on each 2 s snapshot, so timer resets refresh automatically. The same 1 s ticker makes the "last fired N s ago" labels update live (was the stale-time P2 item).

### 3.7 HARDWARE SIMULATOR
- **Refresh** / **Auto** → **Build UI** → **Simulator UI** (ui-template) → **Write**: manual override of any sensor value (writes into `bacnetPoints` directly, bypassing access control since it *is* the simulated hardware).

### 3.8 VIRTUAL POINTS (Sun/Time)
- **Every 1 min** → **Calculate Sun** (SunCalc: altitude, azimuth, daylight flag, sunrise/sunset in minutes) and **Update Time** (hour, minutes-since-midnight, day-of-week, minute-of-week).

### 3.9 WEATHER INTEGRATION
- Settings side: **UI Refresh 5s** → **Build Settings Data** → **Location Settings UI** → **Save Location** (lat/lon/city/country/timezone into `virtualPoints`).
- Data side: **Every 10 min** → **Prepare Request** → **OpenWeatherMap** → **Parse & Update** (writes `glob_outside_temp`, `glob_outside_lux`, etc.).

### 3.10 DEVICE MANAGER
- **Refresh Devices** / **Auto on Boot** → **Build Device Data** → **Device Manager UI** → **Tag Handler**: browse all points, edit tags/zones in `bmsMetadata` at runtime (edits persist to the `file` store).

### 3.11a AI CHAT (Track 2) — in-dashboard assistant, multi-provider
New dashboard page **AI Assistant** (`/dashboard/ai-assistant`, listed first): chat panel +
API-settings panel. **Chat UI** → **Chat Orchestrator** → **Call Anthropic API** (http request,
`method: use` — the orchestrator sets url/headers/payload per provider) → **Process Response**
(final text → chat; tool call → `BMS.applyConfig` → result appended → loops back to the API,
max 5 rounds; apply results shown as chips). **API Key Settings UI** → **Chat Settings Handler**.

**Provider support (anthropic / openai / deepseek):** a provider-adapter layer in Initialize
System keeps the conversation in a **neutral internal history** and translates per provider at
request time:
- `global.aiProviders` — per-provider `{label, style, url, tokenParam, defaultModel, models}`.
  `style: 'anthropic'` (Messages API, `x-api-key`, `tool_use`/`input_schema`) or `'openai'`
  (Chat Completions, `Authorization: Bearer`, `tool_calls`/`function`; used by **OpenAI** and
  **DeepSeek**, which is OpenAI-compatible).
- `global.aiBuildRequest(history, settings)` → `{url, method, headers, payload}` for the active
  provider. `global.aiParseResponse(style, statusCode, body)` → `{ok, error, text, toolCalls, stop}`.
- Neutral history item shapes: `{role:'user', text}` / `{role:'assistant', text, toolCalls:[{id,name,input}]}`
  / `{role:'tool', results:[{id,name,content}]}`. Switching provider mid-conversation is safe;
  `chatHistoryV` bumps reset stale history.

**Settings** (`aiChatSettings`, persisted to `file` store): `{ provider, keys:{anthropic,openai,deepseek},
models:{...} }`. Keys are **plain text and deliberately visible in the UI** (per-provider field +
eye toggle + per-key and "erase all" buttons) so they get erased before transfer. The settings
handler migrates the old single-key `{apiKey, model}` shape automatically.

The system prompt builder is the shared global `buildAIPrompt(mode)` (`'paste'` = legacy prompt
page verbatim incl. alignment guidelines; `'tool'` = same context, tool-calling guidance).

**Reliability (added 2026-06-15):** the `Call Anthropic API` http-request node has a **60 s
timeout** and a **Catch node** (`Catch API errors` → `Chat Error Handler`) — transport errors
and timeouts (which an http-request node does NOT pass to its own output) are otherwise swallowed
and leave the chat stuck on "thinking" (this was the DeepSeek symptom). HTTP error *statuses*
(401/400/429…) come back as normal messages and are surfaced by `aiParseResponse`. The Chat UI
also has a **Cancel** button and a 75 s client-side watchdog so it can never stay stuck
regardless of backend, and ignores a late reply arriving after Cancel.

**API Call Log** (`API Log UI` template, group "API Call Log", below the chat): `global.aiLog(kind, summary, detail)`
keeps a ~1 MB structured ring buffer (`aiApiLog` = array of `{ts, kind, summary, detail}`). Rows are
**click-to-expand**: the summary shows provider/model/status/tokens; the detail shows the full request
body (url, model, tools, messages — long content truncated by `aiLogTrim`, system prompt to 1500 chars)
or full response body. **API keys are never logged** (they live in headers, which are not recorded).
Orchestrator, Process Response, and the error handler all feed it (output 3 → log template).

> **ui-template reception gotcha (2026-06-15) — the real one:** in Dashboard 2.0 (1.30.0) an
> **output-wired ui-template must have `passthru: true` to receive input messages at all**. With
> `passthru: false` and an output connected, incoming messages are dropped — the widget's `msg`
> watcher never fires (diagnosed with an in-widget `rx` counter that stayed at 0 while the reply
> was confirmed delivered to the node). This is why the chat stuck on "thinking": server applied
> the config, but the widget never received the reply. Every working interactive widget (Renderer,
> Simulator, Device Manager, Location, Import) has `passthru: true`; the chat widgets were the
> only output-wired ones set to false. Receive-only widgets (Inspector, Prompt Display, API Log)
> are unaffected. Caveat: `passthru: true` forwards received messages to the widget's output too —
> handlers downstream of an emitting widget must ignore unexpected/echoed topics (the settings
> handler returns null for anything but its request topics to avoid a feedback loop).

### 3.11 BMS API (Track 1) — HTTP endpoints for AI tooling
Five `http-in` → function → shared `http response` chains on `http://127.0.0.1:1880/bms`
(open on localhost like the dashboard; set `BMS_API_TOKEN` env var to require an
`x-bms-token` header). Full reference: `docs/BMS_CONFIG_SCHEMA.md`.
| Endpoint | Role |
|---|---|
| `GET /bms/context` | Live inventory (points, units, ranges, tags, zones), virtual points, tag counts, current config as exact JSON. Replaces the copy-pasted prompt for tooling. |
| `POST /bms/config` | Apply a configuration via `BMS.applyConfig`; returns `{applied, counts, unknownFacts, errors}`. |
| `GET /bms/firelog` | Loaded rules/agents + per-rule fire timestamps — the verification endpoint. |
| `GET /bms/points` | All fact values incl. soft states (`?id=`, `?tag=` filters). |
| `POST /bms/points` | `{id, value}` through the BMS layer (access + clamping); `{id, value, "simulate": true}` raw sensor override for scenario testing. |
| `GET /bms/syslog` | Rolling runtime log ring buffer (node warn/error/info), captured by the `bmsRing` custom logger in settings.js (shared array via `functionGlobalContext.sysLogBuffer`). Query `?n=`, `?level=warn|error`, `?grep=regex`. Curlable server-side debug aid. NB: client-side (browser widget) issues do NOT appear here — those need in-widget instrumentation. |

---

## 4. Data Structures (Node-RED global context)

| Global key | Content | Written by |
|---|---|---|
| `bacnetPoints` | `{ id: { objectName, value, units, access: 'read_only'\|'read_write', min?, max? } }` — 86 points. **Hardware values only**, mirroring what a real BACnet stack would expose. | Init; Safety Guard; Hardware Simulator; Physics; `/bms/points` simulate |
| `bmsMetadata` | `{ id: { tags: [...], zone: 'F1_Lobby' } }` — **BMS-side metadata, deliberately separated from hardware** to prepare for real BACnet integration (hardware via REST later; metadata stays local). | Init; Device Manager |
| `virtualPoints` | Computed/system values: `physics_enabled`, `glob_time_*`, `glob_comfort_sp`, `glob_eco_sp`, `sun_*`, `loc_*`. Flags: `writable`, `source`. | Init; Sun/Time; Weather; Settings |
| `BMS` | Abstraction API: `getValues()`, `getValue(id)`, `writeValue(id, value)` (enforces access + clamping), `setVirtualValue(id, value)`, `getMetadata(id)`, **`applyConfig(cfg)`** (validate + apply + persist an AI configuration — single seam shared by the Import Panel, `POST /bms/config`, and future tool-calling). **All reads/writes go through this object** — the single seam to replace when connecting real BACnet. | Init |
| `ruleGroups` | AI-generated `rule_groups` (json-rules-engine format). | Parse & Apply |
| `stateRegistry` | AI-generated `defined_states` (id, name, type, defaultValue, ttl?, description). | Parse & Apply |
| `behaviorAgents` | AI-generated agents (id, name, description, category, enabled, rule_group). | Parse & Apply |
| `dashboardConfig` | AI-generated `{ widgets: [...] }`. | Parse & Apply |
| `myStateCache` | NodeCache instance holding live soft-state values with TTL auto-expiry. | State Manager |
| `ruleFireLog` | Per-rule fire counters/timestamps for the inspector and `/bms/firelog`. | Rules Engine |

**Persistence (V12.1):** the four AI-config keys, `bmsMetadata`, and `locationSettings`
are mirrored to the `file` context store (`~/.node-red/context/global/global.json`,
~30 s flush) and restored at boot. Everything else is memory-only by design
(`BMS` holds functions; `myStateCache` is a live NodeCache instance).

### Zone/point naming convention
`{floor}_{room}_{function}` — e.g. `f2_off1_temp_setpoint`. Floors: lobby/corridor/meeting/storage (F1), corridor + 3 offices (F2, F3). Globals: `glob_*`. Tags follow a consistent taxonomy: floor (`floor1`…), room kind, `sensor`/`actuator`, function (`temperature`, `lighting`, `hvac_temp`, `hvac_vent`, `co2`, `iaq`, `motion`, `occupancy`, `light`, `setpoint`, `booking`, `schedule`).

---

## 5. The AI Exchange Schema (the "language" the LLM speaks)

> **Canonical, maintained version: `docs/BMS_CONFIG_SCHEMA.md`** (includes the full
> operator list with the inclusive fact-to-fact variants, the optional `ttl` on states,
> all widget types incl. `select`, the critical anti-refire patterns, and the HTTP API).
> The summary below is kept for orientation only.

Single JSON object; each section optional (only present sections are applied):

```json
{
  "behavior_agents": [
    { "id": "agent_x", "name": "...", "description": "...",
      "category": "lighting|climate|security|energy|safety",
      "enabled": true, "rule_group": "rg_x" }
  ],
  "defined_states": [
    { "id": "st_x", "name": "...", "type": "number|boolean",
      "defaultValue": 0, "ttl": 7200, "description": "..." }
  ],
  "rule_groups": [
    { "id": "rg_x", "name": "...", "rules": [
      { "conditions": { "all": [
          { "fact": "f1_lobby_motion", "operator": "equal", "value": true } ] },
        "event": { "type": "control_device|control_group|set_state",
                   "params": { "id": "...", "value": 21 } } }
    ]}
  ],
  "dashboard": { "widgets": [
    { "type": "group", "id": "grp_x", "label": "...", "icon": "mdi-...",
      "color": "...", "badge": "...", "widgets": [
        { "type": "slider|switch|text", "label": "...", "bind": "point_id",
          "min": 15, "max": 25 } ] }
  ]}
}
```

**Operators:** standard json-rules-engine set plus custom fact-to-fact: `lessThanFact`, `greaterThanFact`, `equalFact`, `lessThanInclusiveFact`, etc.
**Event params extensions:** `value_from_fact` (copy another fact's value), `value_expr` (`{ fact, add, subtract, multiply, divide, min, max, round }`), `control_group` with `tag` + optional `unit` filter (unit auto-inferred when using `value_from_fact`; booleans auto-filter to bool actuators).

### Interaction protocol (prompt-engineering learnings — preserve these)
- Instructions at the **beginning** of the prompt carry the most weight with LLMs.
- The AI must **converse first** (summarize current config, ask what to change, clarify) and emit JSON **only** when the user says "ready"/"generate". When this guidance was trimmed for token savings, the LLM regressed to dumping JSON immediately — do not remove the alignment guidelines again.
- Current configuration is exported as **exact JSON** so the AI can do minimal diffs instead of regenerating from scratch.

---

## 6. Dashboard (UI) Map

Dashboard 2.0 (`@flowfuse/node-red-dashboard`), theme "Modern Theme", base "AI BMS Dashboard". Pages:

| Page | Content |
|---|---|
| **AI Assistant** (first) | In-dashboard chat (Anthropic/OpenAI/DeepSeek) that applies config via tool-use; API-key settings panel (per-provider, visible/erasable); expandable API Call Log. See §3.11a. |
| **Control Panel** | Dynamic widgets rendered from `dashboardConfig` (the AI-designed UI). |
| **AI Configuration** | "Generate Prompt" button + prompt display (copy) + "Import AI Configuration" paste panel (the original copy-paste workflow; still works). |
| **Logic Inspector** | Behavior Agents list with live fire stats + live timer countdowns (§3.6). |
| **Hardware Simulator** | Manual sensor override sliders/switches. |
| **Settings** | Location & Weather (lat/lon/city/timezone, OWM status). |
| **Device Manager** | Point browser + tag/zone editor. |

---

## 7. Runtime Loop Summary

1. **Sense** (1 s): Build Facts reads BMS values + soft states.
2. **Think**: Rules Engine evaluates facts against `ruleGroups`.
3. **Act**: `set_state` → NodeCache with TTL; `control_*` → Group Resolver → Safety Guard → `BMS.writeValue`.
4. **Simulate** (2 s): Physics nudges sensors toward realistic values (zone-discovered from metadata).
5. **Visualize**: Dashboard Engine re-renders; user inputs flow back through Filter User Input → BMS.
6. **Iterate**: paste a new AI JSON at any time → hot-reload.

---

## 8. Known Issues & Technical Debt

**Full, current list with statuses: `audit/2026-06-12_audit.md`** (all P0 and P1 items
from that audit are fixed and verified; P2 items remain open). Summary:

Resolved since the original handover:
1. ~~Encoding mojibake (`Â°C`)~~ — fixed before the audit.
2. ~~No persistence~~ — `file` context store + `BMS.applyConfig` mirroring + boot restore (P0).
3. ~~Versioning by filename~~ — git repo is the source of truth (`flows.json`).
4. ~~Sun position dead, engine killed by one bad fact id, slider snap-back, parser corrupting `//` in strings, fail-open physics gate, deploy wiping runtime edits~~ — see audit P0/P1.

Still open:
1. **OWM credential** must be re-entered after every clean import (Node-RED credential store, by design).
2. **No formal JSON-Schema validation**: `BMS.applyConfig` validates fact references and shape informally; an AJV schema (derived from `docs/BMS_CONFIG_SCHEMA.md`) would double as the Track 2 tool contract.
3. **settings.js coupling** (§2.3): silent crash if `functionGlobalContext` is missing. Migrating to function-node module declarations (`functionExternalModules` is already enabled) would make the flow self-contained.
4. **P2 polish** (audit): physics dead-band churn + 0.1 °C setpoint offset, humidity never simulated, `loc_timezone` decorative (demo must stay CET), GPS weather mode dead code, `tag_create` no-op, redundant VIRTUAL POINTS "Update Time" node, Vuetify `gap-N`→`ga-N`, prompt-builder gaps (loc_* section, stale fire-time display).
5. **Dashboard 2.0 pinned at 1.30.0** — old; test §3.4 Vue patterns after any upgrade.
6. **Documentation drift**: `AI_BMS_documentation.docx` describes V8 — historical only, superseded by this document.

---

## 9. Environment Upgrades — status

1. ~~Node-RED 4.x~~ — **done** (4.1.1). Dashboard 2.0 still at 1.30.0 (upgrade pending; re-test §3.4 Vue patterns afterwards).
2. **Self-contained flows** (per-node module declarations instead of `functionGlobalContext`) — still recommended; `functionExternalModules: true` is already set.
3. ~~Persistent context~~ — **done** (§2.3 C).
4. ~~Git + CLAUDE.md~~ — **done** (this repo; `CLAUDE.md` auto-loads the workflow).
5. ~~MCP server config~~ — **done** (`.mcp.json`, project scope, package `node-red-mcp-server`; requires `NODE_RED_TOKEN` env var). The Admin HTTP API (`/flows`, Bearer token from `settings.js`) remains the reliable fallback — full-flow `POST /flows` with `Node-RED-Deployment-Type: full` is the proven update path. Live global context is readable at `GET /context/global/<key>`.

### Working agreements for AI-driven flow edits (carry over)
- Small fix touching ≤2 nodes → provide **full code of each module**, identified by its exact Node-RED UI name (e.g. *"JSON Rules Engine"* in group *LOGIC KERNEL*).
- Larger change → regenerate and deliver the **entire flow JSON** for clean re-import, avoiding manual merge errors. Keep repo `flows.json` and the live system in sync (deploy from the repo file).
- **Rules/config work should NOT touch the flow at all** — use the BMS API (§3.11) or the `/bms-*` slash commands.
- After any change, verify via `GET /bms/firelog` (or the Logic Inspector) that rules load **and fire** — never declare success on import alone.

---

## 10. Next Phase: Removing Copy-Paste (UX Directions)

> **Status 2026-06-12:** copy-paste is already dead for the *engineering* workflow —
> **Track 1 shipped**: the BMS HTTP API (§3.11) + Claude Code slash commands
> (`/bms-status`, `/bms-apply`, `/bms-debug`, `/bms-simulate`). This is a lightweight
> REST realization of Option B's tool set (`get_inventory`→`/bms/context`,
> `apply_config`→`/bms/config`, `read/write_point`→`/bms/points`), and
> `BMS.applyConfig` is the shared seam Option A's tool call will reuse.
> **Next: Option A** (in-dashboard chat) for the *end-user/demo* workflow.

Goal: interact with the AI **from within the dashboard**, no prompt/JSON shuttling. Three viable architectures, in increasing ambition:

**Option A — In-dashboard chat calling the Anthropic API (quickest win).**
Add a chat ui-template on the AI Configuration page. A function + http-request node chain calls the Anthropic Messages API: system prompt = output of *Build AI Prompt (Interactive)* (already built programmatically); conversation history kept in flow context; the model's final JSON is piped straight into *Parse & Apply*. Better: define `apply_bms_config` as a **tool** (tool-use/function calling) with the §5 schema, so the model applies configuration via a structured tool call instead of free-text JSON — the parser becomes a thin validator. Requires an Anthropic API key (separate from claude.ai subscription) stored in settings/env.

**Option B — Expose the BMS as an MCP server (inverts the flow).**
Build MCP endpoints in Node-RED (http-in nodes or a small sidecar) exposing tools like `get_inventory`, `get_rules`, `apply_config`, `read_point`, `write_point`. Then any Claude surface (Claude Code, claude.ai with a custom connector) can inspect and reconfigure the BMS conversationally. No prompt generation step at all — the model pulls exactly the context it needs. Pairs naturally with the Claude Code recommendation since the same MCP config serves development *and* operation.

**Option C — Embedded agent sidecar (Claude Agent SDK).**
A small Node.js service hosting an agent with the BMS tools (Option B's tool set), streaming responses to the dashboard chat over websocket/SSE. Most flexible (multi-turn planning, autonomous verification via the Logic Inspector), most code.

Pragmatic path: **A first** (days of work, kills copy-paste immediately), evolving the JSON paste contract into a tool schema, which is exactly the contract B and C reuse later.

---

## 11. File Inventory

| File | Role |
|---|---|
| `flows.json` | Complete V12.1 flow (100 nodes, 11 groups) — the system itself. Source of truth, kept in sync with the live runtime. |
| `settings.js` | Node-RED config with secrets stripped (functionGlobalContext + contextStorage + adminAuth skeleton). |
| `handover/AI_BMS_Project_Handover.md` | This document — architecture authority. |
| `handover/AI_BMS_BOOTSTRAP_PROMPT.md` | First message for a new AI instance taking over. |
| `audit/2026-06-12_audit.md` | Full audit; current issue list with fix statuses. |
| `docs/BMS_CONFIG_SCHEMA.md` | Canonical AI-config schema + BMS HTTP API reference. |
| `docs/AI_BMS_history.md` | Historical V8 documentation (converted from the old `.docx`) — background only, superseded. |
| `.claude/commands/bms-*.md` | Claude Code slash commands (status / apply / debug / simulate). |
| `.mcp.json` | Node-RED MCP server config (project scope; needs `NODE_RED_TOKEN`). |
| `~/.node-red/settings.js` | Live copy of `settings.js` + real secrets (bcrypt admin hash, API token, OWM key in credential store). |
