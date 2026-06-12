# AI-Driven BMS — Project Handover & Technical Recap

**Version:** V12 (Physics Simulator) — flow export `20260112_flows.json`
**Author:** Olivier — **Handover date:** June 2026
**Purpose of this document:** enable a new AI instance (Claude Code) and other engineers to take over the project without loss of context.

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
Then in `settings.js`:
```js
functionGlobalContext: {
    jsonRulesEngine: require('json-rules-engine'),
    nodeCacheModule: require('node-cache'),
    SunCalc: require('suncalc')
}
```
The flow accesses these via `global.get('jsonRulesEngine')`, `global.get('nodeCacheModule')`, `global.get('SunCalc')`. **If settings.js is not configured, the Logic Kernel and State Manager crash on first tick.**

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

## 3. Node-RED Flow Architecture (V12)

One tab: **"AI BMS V12 (Physics Simulator)"**, organized into 9 visual groups. Names below match the Node-RED UI exactly.

### 3.1 Bootstrap (ungrouped)
- **Boot System** (inject, fires on deploy) → **Initialize System (V12)** (function): defines `bacnetPoints` (93 points, 11 zones, 3 floors), `bmsMetadata` (tags + zones), `virtualPoints`, the **BMS abstraction layer** (global `BMS` object), and initializes empty `ruleGroups`, `stateRegistry`, `behaviorAgents`, `dashboardConfig`.

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
- **Refresh** (button) + **Auto** (inject) → **Build View** → **Inspector** (ui-template): lists agents/rule groups with enable state, categories, and fire counts from `ruleFireLog` — proof that the AI's logic actually loaded and runs.

### 3.7 HARDWARE SIMULATOR
- **Refresh** / **Auto** → **Build UI** → **Simulator UI** (ui-template) → **Write**: manual override of any sensor value (writes into `bacnetPoints` directly, bypassing access control since it *is* the simulated hardware).

### 3.8 VIRTUAL POINTS (Sun/Time)
- **Every 1 min** → **Calculate Sun** (SunCalc: altitude, azimuth, daylight flag, sunrise/sunset in minutes) and **Update Time** (hour, minutes-since-midnight, day-of-week, minute-of-week).

### 3.9 WEATHER INTEGRATION
- Settings side: **UI Refresh 5s** → **Build Settings Data** → **Location Settings UI** → **Save Location** (lat/lon/city/country/timezone into `virtualPoints`).
- Data side: **Every 10 min** → **Prepare Request** → **OpenWeatherMap** → **Parse & Update** (writes `glob_outside_temp`, `glob_outside_lux`, etc.).

### 3.10 DEVICE MANAGER
- **Refresh Devices** / **Auto on Boot** → **Build Device Data** → **Device Manager UI** → **Tag Handler**: browse all points, edit tags/zones in `bmsMetadata` at runtime.

---

## 4. Data Structures (Node-RED global context)

| Global key | Content | Written by |
|---|---|---|
| `bacnetPoints` | `{ id: { objectName, value, units, access: 'read_only'\|'read_write', min?, max? } }` — 93 points. **Hardware values only**, mirroring what a real BACnet stack would expose. | Init; Safety Guard; Hardware Simulator; Physics |
| `bmsMetadata` | `{ id: { tags: [...], zone: 'F1_Lobby' } }` — **BMS-side metadata, deliberately separated from hardware** to prepare for real BACnet integration (hardware via REST later; metadata stays local). | Init; Device Manager |
| `virtualPoints` | Computed/system values: `physics_enabled`, `glob_time_*`, `glob_comfort_sp`, `glob_eco_sp`, `sun_*`, `loc_*`. Flags: `writable`, `source`. | Init; Sun/Time; Weather; Settings |
| `BMS` | Abstraction API: `getValues()`, `getValue(id)`, `writeValue(id, value)` (enforces access + clamping), `setVirtualValue(id, value)`, `getMetadata(id)`. **All reads/writes go through this object** — the single seam to replace when connecting real BACnet. | Init |
| `ruleGroups` | AI-generated `rule_groups` (json-rules-engine format). | Parse & Apply |
| `stateRegistry` | AI-generated `defined_states` (id, name, type, defaultValue, ttl?, description). | Parse & Apply |
| `behaviorAgents` | AI-generated agents (id, name, description, category, enabled, rule_group). | Parse & Apply |
| `dashboardConfig` | AI-generated `{ widgets: [...] }`. | Parse & Apply |
| `myStateCache` | NodeCache instance holding live soft-state values with TTL auto-expiry. | State Manager |
| `ruleFireLog` | Per-rule fire counters/timestamps for the inspector. | Rules Engine |

### Zone/point naming convention
`{floor}_{room}_{function}` — e.g. `f2_off1_temp_setpoint`. Floors: lobby/corridor/meeting/storage (F1), corridor + 3 offices (F2, F3). Globals: `glob_*`. Tags follow a consistent taxonomy: floor (`floor1`…), room kind, `sensor`/`actuator`, function (`temperature`, `lighting`, `hvac_temp`, `hvac_vent`, `co2`, `iaq`, `motion`, `occupancy`, `light`, `setpoint`, `booking`, `schedule`).

---

## 5. The AI Exchange Schema (the "language" the LLM speaks)

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
| **Control Panel** | Dynamic widgets rendered from `dashboardConfig` (the AI-designed UI). |
| **AI Configuration** | "Generate Prompt" button + prompt display (copy) + "Import AI Configuration" paste panel. |
| **Logic Inspector** | Behavior Agents list with live fire stats. |
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

1. **Encoding mojibake**: the flow export contains `Â°C` instead of `°C` (UTF-8 double-encoding) in many strings. Cosmetic, but pollutes the AI prompt and the unit-matching logic in `control_group` (`"unit": "Â°C"` appears in the prompt's schema examples!). Fix by re-saving units as plain `degC` or repairing the encoding once, then re-export.
2. **settings.js coupling** (§2.3): silent crash if `functionGlobalContext` is missing. Migrate to function-node module declarations.
3. **No persistence**: all state lives in in-memory global context; a Node-RED restart loses the AI configuration. Enable a persistent context store (`contextStorage: { default: { module: 'localfilesystem' } }` in settings.js) or persist `ruleGroups`/`stateRegistry`/`behaviorAgents`/`dashboardConfig` to disk on apply and reload at boot.
4. **OWM credential** must be re-entered after every clean import.
5. **No schema validation library**: Parse & Apply checks shape informally. Consider AJV with a published JSON Schema (also reusable as the contract for tool-calling, §10).
6. **Documentation drift**: `AI_BMS_documentation.docx` describes V8 (5 groups, `inventory` array schema). V12 reality: 9 groups, separated `bacnetPoints`/`bmsMetadata`, behavior agents, physics, weather, device manager. This document supersedes it.
7. **Versioning by filename** (`20260112_flows.json`). Move to git (Node-RED "Projects" feature or a plain repo over `~/.node-red`).

---

## 9. Recommended Environment Upgrades

1. **Node-RED 4.x + latest Dashboard 2.0** — check current versions before upgrading; Dashboard 2.0 moves fast and 1.30.0 is several months old. Test the ui-template Vue patterns after upgrade (event-handling quirks of §3.4 may have evolved).
2. **Self-contained flows**: declare `json-rules-engine`, `node-cache`, `suncalc` in the function nodes' Setup/modules tab instead of `functionGlobalContext`.
3. **Persistent context** (see issue 3 above).
4. **Git + CLAUDE.md**: keep `~/.node-red` (or an export folder) under git; add a `CLAUDE.md` at repo root pointing to this document and the bootstrap prompt so Claude Code auto-loads context.
5. **Node-RED MCP server**: keep using an MCP server exposing the Admin API (get-flows / update-flow / inject / diagnostics…). Pin and document the exact package used (the current setup exposes 20 tools incl. `get-flows-formatted`, `update-flow`, `inject`, `visualize-flows`). Configure it in the new environment via `claude mcp add` (project scope, `.mcp.json` committed to the repo). The Node-RED **Admin HTTP API** (`http://127.0.0.1:1880/flows`, `/flow/:id`) is the fallback if the MCP server misbehaves — Claude Code can `curl` it directly.

### Working agreements for AI-driven flow edits (carry over)
- Small fix touching ≤2 nodes → provide **full code of each module**, identified by its exact Node-RED UI name (e.g. *"JSON Rules Engine"* in group *LOGIC KERNEL*).
- Larger change → regenerate and deliver the **entire flow JSON** for clean re-import (delete `flows.json` first), avoiding manual merge errors.
- `update-flows` via MCP requires properly stringified JSON; **complete flow updates are more reliable than partial ones**, especially when group membership or wiring changes.

---

## 10. Next Phase: Removing Copy-Paste (UX Directions)

Goal: interact with the AI **from within the dashboard**, no prompt/JSON shuttling. Three viable architectures, in increasing ambition:

**Option A — In-dashboard chat calling the Anthropic API (quickest win).**
Add a chat ui-template on the AI Configuration page. A function + http-request node chain calls the Anthropic Messages API: system prompt = output of *Build AI Prompt (Interactive)* (already built programmatically); conversation history kept in flow context; the model's final JSON is piped straight into *Parse & Apply*. Better: define `apply_bms_config` as a **tool** (tool-use/function calling) with the §5 schema, so the model applies configuration via a structured tool call instead of free-text JSON — the parser becomes a thin validator. Requires an Anthropic API key (separate from claude.ai subscription) stored in settings/env.

**Option B — Expose the BMS as an MCP server (inverts the flow).**
Build MCP endpoints in Node-RED (http-in nodes or a small sidecar) exposing tools like `get_inventory`, `get_rules`, `apply_config`, `read_point`, `write_point`. Then any Claude surface (Claude Code, claude.ai with a custom connector) can inspect and reconfigure the BMS conversationally. No prompt generation step at all — the model pulls exactly the context it needs. Pairs naturally with the Claude Code recommendation since the same MCP config serves development *and* operation.

**Option C — Embedded agent sidecar (Claude Agent SDK).**
A small Node.js service hosting an agent with the BMS tools (Option B's tool set), streaming responses to the dashboard chat over websocket/SSE. Most flexible (multi-turn planning, autonomous verification via the Logic Inspector), most code.

Pragmatic path: **A first** (days of work, kills copy-paste immediately), evolving the JSON paste contract into a tool schema, which is exactly the contract B and C reuse later.

---

## 11. File Inventory for Transfer

| File | Role |
|---|---|
| `20260112_flows.json` | Complete V12 flow (72 nodes) — the system itself. |
| `AI_BMS_Project_Handover.md` | This document — authoritative. |
| `AI_BMS_BOOTSTRAP_PROMPT.md` | Prompt to initialize the new AI instance. |
| `AI_BMS_documentation.docx` | Historical V8 doc — background only, superseded. |
| `~/.node-red/settings.js` | **Must be transferred or recreated** (functionGlobalContext + OWM key re-entry). |
