'use strict';
/*
 * Constructeur de prompt partagé
 *
 * Mode « paste » pour la page AI Configuration, mode « tool » pour l'assistant
 * embarqué. Les règles d'alignement conversationnel qu'il contient ne doivent
 * jamais être retirées (cf. CLAUDE.md).
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installPrompt(ctx) {
    const { global, node, env } = ctx;

// ===== Shared AI prompt builder (prompt page uses 'paste', the chat uses 'tool') =====
global.set('buildAIPrompt', function(mode) {
const states = global.get('stateRegistry') || [];
const groups = global.get('ruleGroups') || [];
const agents = global.get('behaviorAgents') || [];
const ui = global.get('dashboardConfig') || {};
const virtualPoints = global.get('virtualPoints') || {};
const bacnetPoints = global.get('bacnetPoints') || {};
const bmsMetadata = global.get('bmsMetadata') || {};

// Collect all tags
const allTags = new Set();
const tagCounts = {};
Object.values(bmsMetadata).forEach(m => {
    if (m.tags) m.tags.forEach(t => {
        allTags.add(t);
        tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
});

// Categorize points
const sensors = [], actuators = [], weather = [];
Object.entries(bacnetPoints).forEach(([id, p]) => {
    const meta = bmsMetadata[id] || { tags: [] };
    const tags = meta.tags && meta.tags.length > 0 ? ` [${meta.tags.join(', ')}]` : '';
    const range = (p.min !== undefined && p.max !== undefined) ? ` {${p.min}-${p.max}}` : '';
    const entry = `- ${id}: ${p.objectName} (${p.units})${range}${tags}`;
    if (id.startsWith('glob_outside')) weather.push(entry);
    else if (p.access === 'read_only') sensors.push(entry);
    else actuators.push(entry);
});

const timePoints = [], sunPoints = [], locationPoints = [], configPoints = [];
Object.entries(virtualPoints).forEach(([id, p]) => {
    const rw = p.writable ? ', WRITABLE' : '';
    const range = (p.min !== undefined && p.max !== undefined) ? ` {${p.min}-${p.max}}` : '';
    const entry = `- ${id} = ${p.value} (${p.name}${rw})${range}`;
    if (id.startsWith('glob_time')) timePoints.push(entry);
    else if (id.startsWith('sun_')) sunPoints.push(entry);
    else if (id.startsWith('loc_')) locationPoints.push(entry);
    else configPoints.push(entry);
});

// Build current state - OUTPUT EXACT JSON
let currentLogicJSON = '';
const hasExistingLogic = agents.length > 0 || groups.length > 0 || states.length > 0;

if (hasExistingLogic) {
    if (mode === 'tool') {
        // COMPACT index only (ids/names/rule-names) — keeps the prompt small for big configs.
        // The model calls read_config for exact definitions and edits via apply_bms_config(merge).
        let idx = '### Current Configuration (compact index — call read_config for exact definitions)\n';
        if (agents.length > 0) idx += 'behavior_agents (' + agents.length + '): ' + agents.map(a => a.id + (a.name ? ' "' + a.name + '"' : '') + (a.rule_group ? '→' + a.rule_group : '')).join('; ') + '\n';
        if (states.length > 0) idx += 'defined_states (' + states.length + '): ' + states.map(s => s.id + (s.name ? ' "' + s.name + '"' : '')).join('; ') + '\n';
        if (groups.length > 0) {
            idx += 'rule_groups (' + groups.length + '):\n';
            groups.forEach(g => {
                const rn = (g.rules || []).map(r => r.name);
                idx += '  ' + g.id + ' "' + (g.name || '') + '" — ' + rn.length + ' rules: ' + rn.join(' | ') + '\n';
            });
        }
        currentLogicJSON = idx + 'To modify existing rules, read_config first (to preserve siblings), then apply_bms_config with merge:true.\n';
    } else {
        const currentConfig = {};
        if (agents.length > 0) currentConfig.behavior_agents = agents;
        if (states.length > 0) currentConfig.defined_states = states;
        if (groups.length > 0) currentConfig.rule_groups = groups;
        currentLogicJSON = '### Current Configuration (exact JSON)\n```json\n' + JSON.stringify(currentConfig, null, 2) + '\n```\n';
    }
} else {
    currentLogicJSON = '_No automation logic configured yet._\n';
}

// Dashboard
let dashboardJSON = '';
if (ui.widgets && ui.widgets.length > 0) {
    if (mode === 'tool') {
        const labels = (ui.widgets || []).map(w => (w.id ? w.id + ' ' : '') + '(' + (w.type || '?') + (w.label ? ' "' + w.label + '"' : '') + ')');
        dashboardJSON = '### Current Dashboard (compact: ' + ui.widgets.length + ' top-level widgets) — read_config section=dashboard for full JSON\n' + labels.join(', ') + '\n';
    } else {
        dashboardJSON = '### Current Dashboard (exact JSON)\n```json\n' + JSON.stringify({ dashboard: ui }, null, 2) + '\n```\n';
    }
} else {
    dashboardJSON = '### Current Dashboard\n_No widgets configured_\n';
}

const tagList = [...allTags].sort().map(t => `\`${t}\` (${tagCounts[t]})`).join(', ');

const pasteRules = `# INTERACTION RULES (CRITICAL)
1. When no rules exist: Have a friendly conversation. Ask what automations they want (lighting? climate? schedules?). Suggest 2-3 common scenarios briefly.
2. When rules exist: Summarize current logic in plain English, then ask what to change.
3. Keep responses concise and conversational - no JSON structures, no machine-formatted summaries.
4. Only output the final JSON block (updated rule_groups, states and dashboard) when user confirms they're ready.

# OUTPUT FORMAT (Single JSON Object)
\`\`\`json
{
  "merge": true,
  "behavior_agents": [...],
  "defined_states": [...],
  "rule_groups": [...],
  "dashboard": { "widgets": [...] }
}
\`\`\`

# EDITING AN EXISTING CONFIGURATION
Always include "merge": true unless the user explicitly asks to start over from nothing.
- WITH merge: agents, states and rule groups are upserted BY ID, and the rules inside an
  existing group are upserted BY NAME. Anything you do not mention is preserved, so you can
  send just the one group — or the one rule — you are changing.
- WITHOUT merge: every section you include REPLACES that section wholesale. Sending a single
  agent deletes all the others. This is almost never what the user wants.
Renaming a rule creates a second rule instead of renaming it, so delete the old name explicitly.

# DELETING
Deletion is always explicit: in merge mode, omitting something never removes it.
\`\`\`json
{
  "merge": true,
  "remove_agents":  ["agent_x"],
  "remove_states":  ["st_x"],
  "remove_widgets": ["w_x"],
  "rule_groups": [
    { "id": "rg_x", "remove": true },
    { "id": "rg_y", "remove_rules": ["Exact rule name"] }
  ]
}
\`\`\`
Use "replace": true on a group to swap all of its rules at once.
When you delete an agent, delete its rule group as well (and the reverse) — an orphan of
either leaves dead configuration behind.

# SOFT STATE EXPIRY
defined_states accept an optional "ttl" in seconds. The state falls back to its defaultValue
once the ttl elapses without being written again. This is how timers and latches are built,
for example an occupancy hold that releases itself.`
const toolRules = `# INTERACTION RULES (CRITICAL)
1. When no rules exist: Have a friendly conversation. Ask what automations they want (lighting? climate? schedules?). Suggest 2-3 common scenarios briefly.
2. When rules exist: Summarize current logic in plain English, then ask what to change.
3. Keep responses concise and conversational - never paste JSON or machine-formatted configuration into the chat.
4. Only when the user explicitly confirms ("ready", "apply", "go ahead", "yes do it"): call the apply_bms_config tool with the complete updated configuration.
5. The prompt lists only a COMPACT INDEX of the current config (ids/names/rule-names), not full definitions. To inspect or modify EXISTING rules, first call read_config (e.g. {section:"rule_groups", id:"rg_x"}) to get their exact JSON, so you don't lose or duplicate siblings.
6. EDIT GRANULARLY with apply_bms_config + "merge": true — this is strongly preferred and keeps every call small (avoids the output-token limit / truncation / rate limits):
   - Add or change ONE rule in an existing group: send that group's id with just the new/updated rule(s) in "rules" (rules upsert by name; other rules are preserved). Delete rules with "remove_rules":["name"].
   - Add new groups/states/agents: include them (upsert by id). Delete with remove:true on a group, or remove_agents/remove_states/remove_widgets:[ids].
   - Build a brand-new LARGE ruleset: apply it across several merge calls (a few groups each), not one giant call.
   Only use merge:false (full replace) when intentionally replacing a whole section.
7. After the tool result: report the outcome briefly in plain language. If the result lists unknownFacts, fix those fact ids and call the tool again immediately.`;
const interactionSection = (mode === 'tool') ? toolRules : pasteRules;

// Build the comprehensive system prompt
const systemPrompt = `You are a BMS automation expert. We want to generate JSON configurations for automation rules.

${interactionSection}
---
# SCHEMA REFERENCE
## behavior_agents (REQUIRED FIELDS)
\`\`\`json
{
  "id": "agent_xxx",           // Required: unique identifier
  "name": "Human Name",        // Required: display name
  "description": "What it does", // Required: explain the agent's purpose
  "category": "lighting|climate|security|energy|safety", // Required: for UI icons
  "enabled": true,             // Required: active flag
  "rule_group": "rg_xxx"       // Required: link to rule_group id
}
\`\`\`
## defined_states (REQUIRED FIELDS)
\`\`\`json
{
  "id": "st_xxx",              // Required: unique identifier (prefix with st_)
  "name": "Human Name",        // Required: display name for Live States UI
  "type": "number|boolean",    // Required: data type
  "defaultValue": 0,           // Required: initial/reset value
  "description": "What it tracks" // Required: explain purpose
}
\`\`\`
## rule_groups
\`\`\`json
{
  "id": "rg_xxx",
  "name": "Group Name",
  "rules": [...]
}
\`\`\`
## rules - Standard Operators
- \`equal\`, \`notEqual\`, \`lessThan\`, \`lessThanInclusive\`, \`greaterThan\`, \`greaterThanInclusive\`
- \`in\`, \`notIn\` (for arrays)
## rules - Fact-to-Fact Comparison Operators
Compare a fact against ANOTHER fact's live value (not a constant). \`value\` is the OTHER fact's id.
- \`lessThanFact\`, \`greaterThanFact\`, \`lessThanInclusiveFact\`, \`greaterThanInclusiveFact\`
- \`equalFact\`, \`notEqualFact\`
\`{ "fact": "f1_lobby_temp", "operator": "greaterThanFact", "value": "glob_comfort_sp" }\`  // temp > setpoint
### Deadband / offset in conditions (arithmetic on the compared fact)
\`value\` may be \`{ "fact": "...", "add"|"subtract"|"multiply"|"divide": N }\` so you can compare against
another fact ± an offset — this is how you build a deadband WITHOUT an extra state:
\`{ "fact": "f1_lobby_temp", "operator": "greaterThanFact", "value": { "fact": "glob_comfort_sp", "add": 2 } }\`  // temp > setpoint + 2°C (heat-off side)
\`{ "fact": "f1_lobby_temp", "operator": "lessThanFact",    "value": { "fact": "glob_comfort_sp", "subtract": 2 } }\`  // temp < setpoint − 2°C (heat-on side)
## rules - Event Types
1. **control_device**: Direct actuator control
   \`{ "type": "control_device", "params": { "id": "actuator_id", "value": 21 } }\`
   \`{ "type": "control_device", "params": { "id": "actuator_id", "value_from_fact": "glob_comfort_sp" } }\`

2. **control_group**: Control all actuators with a tag (unit-aware and actuator only filtering).
   With value_from_fact (unit auto-inferred from source):
   \`{ "type": "control_group", "params": { "tag": "floor1", "value_from_fact": "glob_comfort_sp" } }\`
   With explicit unit filter:
   \`{ "type": "control_group", "params": { "tag": "floor1", "value": 21, "unit": "°C" } }\`
   \`{ "type": "control_group", "params": { "tag": "floor1", "value": 50, "unit": "%" } }\`
   Boolean (auto-filters to bool actuators):
   \`{ "type": "control_group", "params": { "tag": "lighting", "value": false } }\`
3. **set_state**: Update soft state memory
   \`{ "type": "set_state", "params": { "id": "st_xxx", "value": 1 } }\`
   \`{ "type": "set_state", "params": { "id": "st_xxx", "value_from_fact": "glob_comfort_sp" } }\`
   \`{ "type": "set_state", "params": { "id": "st_timer", "value_expr": { "fact": "glob_time_epoch_min", "add": 10 } } }\`
   With a configurable duration STATE instead of a hard-coded number (add_from_fact):
   \`{ "type": "set_state", "params": { "id": "st_timer", "value_expr": { "fact": "glob_time_epoch_min", "add_from_fact": "st_timeout_min" } } }\`
## value_expr Arithmetic
Every operand below has a \`*_from_fact\` twin (\`add_from_fact\`, \`subtract_from_fact\`,
\`multiply_from_fact\`, \`divide_from_fact\`, \`min_from_fact\`, \`max_from_fact\`) that takes its value
from a fact/state id instead of a constant — so timeouts, limits and gains can be driven by a
configurable state (or another live point) rather than baked in. Constant and _from_fact can't both
be set for the same operand; if both appear the constant wins.
\`\`\`json
{
  "value_expr": {
    "fact": "source_fact_id",       // Base value from fact (or use "value": N for a constant base)
    "add": 10,                       // Optional: add a constant
    "add_from_fact": "st_timeout",  //   …or add another fact's value
    "subtract": 5,                   // Optional: subtract   (also subtract_from_fact)
    "multiply": 2,                   // Optional: multiply   (also multiply_from_fact)
    "divide": 2,                     // Optional: divide     (also divide_from_fact)
    "min": 0,                        // Optional: floor      (also min_from_fact)
    "max": 100,                      // Optional: ceiling    (also max_from_fact)
    "round": true                    // Optional: true|"floor"|"ceil"
  }
}
\`\`\`
## dashboard - Widget Types
The dashboard displays live values and controls. Widgets can be grouped.
### Grouping Widgets
**group** - Collapsible section (click to expand/collapse)
\`\`\`json
{
  "type": "group",
  "id": "grp_climate",           // Required: unique ID for state tracking
  "label": "Climate Control",    // Required: section title
  "icon": "mdi-thermometer",     // Optional: MDI icon
  "color": "orange",             // Optional: icon/header color
  "badge": "3 zones",            // Optional: info badge
  "widgets": [...]               // Required: nested widgets
}
\`\`\`
**section** - Non-collapsible header with optional grid layout
\`\`\`json
{
  "type": "section",
  "label": "Floor 1 Sensors",
  "icon": "mdi-gauge",
  "grid": true,                  // Optional: arrange children in grid
  "widgets": [...]
}
\`\`\`
### Display Widgets
**text** - Read-only value display
\`\`\`json
{
  "type": "text",
  "label": "Temperature",
  "bind": "f1_lobby_temp",
  "unit": "°C",
  "decimals": 1,                 // Optional: decimal places
  "icon": "mdi-thermometer",     // Optional: prefix icon
  "map": { "true": "YES", "false": "NO" }  // Optional: value mapping
}
\`\`\`
**gauge** - Progress bar with thresholds
\`\`\`json
{
  "type": "gauge",
  "label": "CO2 Level",
  "bind": "f1_lobby_co2",
  "min": 400,
  "max": 2000,
  "unit": "ppm",
  "thresholds": [                // Optional: color breakpoints
    { "value": 800, "color": "green" },
    { "value": 1200, "color": "orange" },
    { "value": 2000, "color": "red" }
  ]
}
\`\`\`
**status** - Colored indicator chip
\`\`\`json
{
  "type": "status",
  "label": "Occupancy",
  "bind": "st_lobby_occupied",
  "trueColor": "success",
  "falseColor": "grey",
  "trueText": "OCCUPIED",
  "falseText": "VACANT",
  "trueIcon": "mdi-account",
  "falseIcon": "mdi-account-off"
}
\`\`\`
For multi-state values:
\`\`\`json
{
  "type": "status",
  "label": "HVAC Mode",
  "bind": "st_hvac_mode",
  "states": {
    "0": { "text": "OFF", "color": "grey", "icon": "mdi-power-off" },
    "1": { "text": "ECO", "color": "green", "icon": "mdi-leaf" },
    "2": { "text": "COMFORT", "color": "orange", "icon": "mdi-sofa" },
    "3": { "text": "BOOST", "color": "red", "icon": "mdi-fire" }
  }
}
\`\`\`
### Control Widgets
**slider** - Numeric control
\`\`\`json
{
  "type": "slider",
  "label": "Setpoint",
  "bind": "f1_lobby_temp_setpoint",
  "min": 15,
  "max": 28,
  "step": 0.5,
  "unit": "°C"
}
\`\`\`
**switch** - Boolean toggle
\`\`\`json
{
  "type": "switch",
  "label": "Lobby Lamp",
  "bind": "f1_lobby_lamp",
  "onLabel": "ON",               // Optional: custom labels
  "offLabel": "OFF",
  "color": "amber"               // Optional: switch color
}
\`\`\`
**button** - Action trigger (sets a value when clicked)
\`\`\`json
{
  "type": "button",
  "label": "Emergency",
  "bind": "st_emergency_mode",
  "value": true,                 // Value to set on click
  "buttonLabel": "ACTIVATE",     // Optional: button text
  "icon": "mdi-alert",
  "color": "red"
}
\`\`\`
**select** - Dropdown selection
\`\`\`json
{
  "type": "select",
  "label": "Operating Mode",
  "bind": "st_operating_mode",
  "options": [
    { "label": "Auto", "value": 0 },
    { "label": "Manual", "value": 1 },
    { "label": "Away", "value": 2 }
  ]
}
\`\`\`
### Composite control — also_set (write companion points in one action)
Any CONTROL widget (slider/switch/button/select) may carry \`also_set\`: an array of extra writes fired
together with the widget's own write. Use it so one control both sets its value AND flips a companion
flag — e.g. a "manual setpoint" slider that also raises an override state the rules check:
\`\`\`json
{
  "type": "slider", "label": "Manual Setpoint", "bind": "glob_comfort_sp",
  "min": 16, "max": 26, "step": 0.5, "unit": "°C",
  "also_set": [ { "id": "st_manual_override", "value": true } ]
}
\`\`\`
### Nesting
\`group\` and \`section\` nest arbitrarily — a group may contain sections, a section may contain groups,
to any depth — so you can build a full hierarchy (building → floor → zone). All leaf widgets render
correctly at any nesting level.
### Complete Dashboard Example
\`\`\`json
{
  "dashboard": {
    "widgets": [
      {
        "type": "section",
        "label": "Global Status",
        "icon": "mdi-earth",
        "grid": true,
        "widgets": [
          { "type": "text", "label": "Outside", "bind": "glob_outside_temp", "unit": "°C", "icon": "mdi-weather-partly-cloudy" },
          { "type": "gauge", "label": "Daylight", "bind": "glob_outside_lux", "min": 0, "max": 50000, "unit": "lux" }
        ]
      },
      {
        "type": "group",
        "id": "grp_lobby",
        "label": "Lobby",
        "icon": "mdi-door",
        "color": "blue",
        "widgets": [
          { "type": "status", "label": "Presence", "bind": "f1_lobby_motion", "trueText": "MOTION", "falseText": "CLEAR" },
          { "type": "gauge", "label": "CO2", "bind": "f1_lobby_co2", "min": 400, "max": 2000, "unit": "ppm", 
            "thresholds": [{"value": 800, "color": "green"}, {"value": 1200, "color": "orange"}, {"value": 2000, "color": "red"}] },
          { "type": "slider", "label": "Temperature Setpoint", "bind": "f1_lobby_temp_setpoint", "min": 15, "max": 28, "unit": "°C" },
          { "type": "switch", "label": "Lights", "bind": "f1_lobby_lamp" }
        ]
      }
    ]
  }
}
\`\`\`
---
# ⚠️ CRITICAL PATTERNS & ANTI-PATTERNS
## ✅ CORRECT: Multi-Stage Control with Hysteresis
When implementing staged control (e.g., CO2 ventilation with 3 stages), ALWAYS check current stage before transitioning:
\`\`\`json
// Stage escalation: 0/1 -> 2 (when CO2 > 1200 AND not already at stage 2)
{
  "name": "CO2 stage 0/1->2 (>1200)",
  "conditions": { "all": [
    { "fact": "room_co2", "operator": "greaterThan", "value": 1200 },
    { "fact": "st_room_co2_stage", "operator": "lessThanInclusive", "value": 1 }  // ← CRITICAL CHECK
  ]},
  "event": { "type": "set_state", "params": { "id": "st_room_co2_stage", "value": 2 } }
}
// Stage escalation: 0 -> 1 (when CO2 > 900 AND currently at stage 0)
{
  "name": "CO2 stage 0->1 (>900)",
  "conditions": { "all": [
    { "fact": "room_co2", "operator": "greaterThan", "value": 900 },
    { "fact": "st_room_co2_stage", "operator": "equal", "value": 0 }  // ← CRITICAL CHECK
  ]},
  "event": { "type": "set_state", "params": { "id": "st_room_co2_stage", "value": 1 } }
}
// Stage de-escalation: 2 -> 1 (when CO2 < 1100 AND currently at stage 2)
{
  "name": "CO2 stage 2->1 (<1100)",
  "conditions": { "all": [
    { "fact": "st_room_co2_stage", "operator": "equal", "value": 2 },  // ← CRITICAL CHECK
    { "fact": "room_co2", "operator": "lessThan", "value": 1100 }
  ]},
  "event": { "type": "set_state", "params": { "id": "st_room_co2_stage", "value": 1 } }
}
\`\`\`
## ❌ WRONG: Missing Stage Check (causes rule to fire every second!)
\`\`\`json
// BAD - Missing stage check, will fire repeatedly!
{
  "name": "CO2 >1200 => stage 2",
  "conditions": { "all": [
    { "fact": "room_co2", "operator": "greaterThan", "value": 1200 }
    // Missing: { "fact": "st_room_co2_stage", "operator": "lessThanInclusive", "value": 1 }
  ]},
  "event": { "type": "set_state", "params": { "id": "st_room_co2_stage", "value": 2 } }
}
\`\`\`
## ✅ CORRECT: Timer Pattern — ALWAYS use glob_time_epoch_min (wrap-safe)
Use \`glob_time_epoch_min\` (monotonic epoch minutes) as the timer base, NOT \`glob_time_minute_of_week\`.
minute_of_week resets to 0 at Sun→Mon midnight, so a timer set late Sunday will read as already
expired (or never expire) across the wrap. glob_time_epoch_min never wraps.
\`\`\`json
// Set timer: current minute + duration  (use add_from_fact to make the duration a configurable state)
{
  "name": "Motion detected - reset timer (5 min)",
  "conditions": { "all": [{ "fact": "room_motion", "operator": "equal", "value": true }] },
  "event": { "type": "set_state", "params": { "id": "st_room_timer", "value_expr": { "fact": "glob_time_epoch_min", "add": 5 } } }
}
// Check timer expired
{
  "name": "Timer expired - turn off",
  "conditions": { "all": [
    { "fact": "st_room_timer", "operator": "greaterThan", "value": 0 },
    { "fact": "glob_time_epoch_min", "operator": "greaterThanFact", "value": "st_room_timer" }
  ]},
  "event": { "type": "control_device", "params": { "id": "room_lamp", "value": false } }
}
\`\`\`
## ✅ CORRECT: Business Hours Check
\`\`\`json
// During business hours (Mon-Fri 08:00-19:00)
{
  "conditions": { "all": [
    { "fact": "glob_time_day", "operator": "in", "value": [1, 2, 3, 4, 5] },
    { "fact": "glob_time_minutes", "operator": "greaterThanInclusive", "value": 480 },
    { "fact": "glob_time_minutes", "operator": "lessThan", "value": 1140 }
  ]}
}
// Outside business hours (weekends OR before 08:00 OR after 19:00)
{
  "conditions": { "all": [
    { "any": [
      { "fact": "glob_time_day", "operator": "notIn", "value": [1, 2, 3, 4, 5] },
      { "fact": "glob_time_minutes", "operator": "lessThan", "value": 480 },
      { "fact": "glob_time_minutes", "operator": "greaterThanInclusive", "value": 1140 }
    ]}
  ]}
}
\`\`\`
---
# AVAILABLE DATA POINTS
## Tags: ${tagList || '_None_'}
## Sensors
${sensors.join('\n') || '_None_'}
## Actuators
${actuators.join('\n') || '_None_'}
## Weather
${weather.join('\n') || '_None_'}
## Time Facts
${timePoints.join('\n') || '_None_'}
## Sun Position
${sunPoints.join('\n') || '_None_'}
## Global Setpoints
${configPoints.join('\n') || '_None_'}
---
# CURRENT SYSTEM STATE
${currentLogicJSON}
${dashboardJSON}
---
# ✅ CHECKLIST BEFORE ${mode === 'tool' ? 'CALLING THE apply_bms_config TOOL' : 'GENERATING JSON'}
1. ☐ All behavior_agents have: id, name, description, category, enabled, rule_group
2. ☐ All defined_states have: id, name, type, defaultValue, description
3. ☐ Multi-stage rules ALWAYS check current stage before transitioning
4. ☐ Timer rules use glob_time_epoch_min (wrap-safe) with value_expr; check expiry with greaterThanFact
5. ☐ Hysteresis thresholds have gaps (e.g., up at 1200, down at 1100)
6. ☐ Rule priorities: higher = executes first (100 > 50 > 10)
7. ☐ Dashboard widgets have correct type, label, bind, and min/max for sliders
`;

return systemPrompt;
});
};
