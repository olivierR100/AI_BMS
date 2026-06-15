# BMS Configuration Schema & API Reference

The contract between any AI tool and the BMS runtime. Same schema everywhere:
the dashboard Import Panel, `POST /bms/config`, and (future) tool-calling all
feed `BMS.applyConfig()`.

## HTTP API (base `http://127.0.0.1:1880/bms`)

| Endpoint | Purpose |
|---|---|
| `GET /context` | Full live inventory: `points.{sensors,actuators,weather}` (value, units, min/max, tags, zone), `virtualPoints`, `tags` (with counts), `config` (the four sections currently applied — exact JSON, use for minimal diffs). |
| `POST /config` | Apply a configuration object (below). Returns `{applied, counts, unknownFacts, errors}`. Unknown facts don't block apply but the rules referencing them never fire — treat as a failure and fix. |
| `GET /firelog` | `rulesLoaded`, per-group rule names + enabled, agents, `fireLog` (per-rule last-fired timestamps), `physics_enabled`. **The verification tool: a config isn't done until its rules appear here and fire.** |
| `GET /points` | All current fact values (BACnet + virtual + soft states). `?id=x` for one (+metadata), `?tag=x` to filter by tag. |
| `POST /points` | `{id, value}` writes through the BMS layer (access enforced, min/max clamped). `{id, value, "simulate": true}` overrides any raw sensor value (test scenarios — physics will drift it afterwards). |

Auth: open on localhost (like the dashboard). If `BMS_API_TOKEN` is set in the
Node-RED environment, requests must send it in the `x-bms-token` header.

## Configuration object

Single JSON object; each section optional — **only present sections are
replaced** (a section you omit is left untouched; an empty array clears it).
Applied config persists to disk and survives Node-RED restarts.

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
      { "name": "...", "priority": 1,
        "conditions": { "all|any": [
          { "fact": "f1_lobby_motion", "operator": "equal", "value": true } ] },
        "event": { "type": "control_device|control_group|set_state",
                   "params": { "id": "...", "value": 21 } } }
    ]}
  ],
  "dashboard": { "widgets": [ ... ] }
}
```

All `behavior_agents` fields are required. All `defined_states` fields except
`ttl` are required (`ttl` in seconds — state auto-expires back to
`defaultValue`).

### Operators
- Standard: `equal`, `notEqual`, `lessThan`, `lessThanInclusive`,
  `greaterThan`, `greaterThanInclusive`, `in`, `notIn` (arrays)
- Fact-to-fact (compare against another fact's live value, put its id in
  `value`): `lessThanFact`, `greaterThanFact`, `equalFact`,
  `lessThanInclusiveFact`, `greaterThanInclusiveFact`

### Event types
1. `control_device` — `params: { id, value }` or `{ id, value_from_fact: "fact_id" }`
2. `control_group` — every read_write point with a tag:
   `{ tag, value, unit? }` or `{ tag, value_from_fact }` (unit auto-inferred;
   booleans auto-filter to bool actuators). Unit filter values: `°C`, `%`, `bool`, `lux`, `ppm`.
3. `set_state` — `{ id, value }`, `{ id, value_from_fact }`, or
   `{ id, value_expr: { fact, add?, subtract?, multiply?, divide?, min?, max?, round? } }`
   (`round`: `true` | `"floor"` | `"ceil"`); optional `ttl` (seconds) overrides the state's registry TTL.

### Widget types (dashboard.widgets, nestable via group/section)
- `group` — collapsible: `{ type, id, label, icon?, color?, badge?, widgets }`
- `section` — header: `{ type, label, icon?, grid?, widgets }`
- `text` — `{ type, label, bind, unit?, decimals?, icon?, map? }`
- `gauge` — `{ type, label, bind, min, max, unit?, thresholds?: [{value, color}] }`
- `status` — `{ type, label, bind, trueColor?, falseColor?, trueText?, falseText?, trueIcon?, falseIcon? }` or multi-state `states: { "0": {text, color, icon}, ... }`
- `slider` — `{ type, label, bind, min, max, step?, unit? }`
- `switch` — `{ type, label, bind, onLabel?, offLabel?, color? }`
- `button` — `{ type, label, bind, value, buttonLabel?, icon?, color? }`
- `select` — `{ type, label, bind, options: [{label, value}] }`

## Critical patterns (the engine re-evaluates EVERY SECOND — design for it)

**Hysteresis / staged control — always check the current stage before
transitioning**, otherwise the rule fires every tick:

```json
{ "name": "CO2 stage 0/1 -> 2",
  "conditions": { "all": [
    { "fact": "room_co2", "operator": "greaterThan", "value": 1200 },
    { "fact": "st_co2_stage", "operator": "lessThanInclusive", "value": 1 } ]},
  "event": { "type": "set_state", "params": { "id": "st_co2_stage", "value": 2 } } }
```
De-escalation thresholds need a gap (up at 1200, down at 1100).

**Timers — use `glob_time_minute_of_week` with `value_expr`:**
```json
{ "name": "motion resets 5-min timer",
  "conditions": { "all": [{ "fact": "room_motion", "operator": "equal", "value": true }] },
  "event": { "type": "set_state", "params": { "id": "st_room_timer",
             "value_expr": { "fact": "glob_time_minute_of_week", "add": 5 } } } },
{ "name": "timer expired -> off",
  "conditions": { "all": [
    { "fact": "st_room_timer", "operator": "greaterThan", "value": 0 },
    { "fact": "glob_time_minute_of_week", "operator": "greaterThanFact", "value": "st_room_timer" } ]},
  "event": { "type": "control_device", "params": { "id": "room_lamp", "value": false } } }
```
A timer state holds an **absolute expiry** (a minute-of-week value), not a remaining
duration. The Logic Inspector auto-detects any state written this way (set_state from
`glob_time_minute_of_week`) and shows it as a **live countdown** (recomputed each 2 s
snapshot, so a re-trigger that bumps the target refreshes the countdown). Edge case: a
timer set within ~`add` minutes of the Sunday→Monday week rollover won't count down
correctly (minute-of-week wraps to 0) — irrelevant for typical minute/hour BMS timers.

**Business hours:** `glob_time_day` `in [1,2,3,4,5]` (Mon=1…Sun=7) +
`glob_time_minutes` range (480 = 08:00, 1140 = 19:00).

## Conventions
- Point ids: `{floor}_{room}_{function}` (e.g. `f2_off1_temp_setpoint`); globals `glob_*`; sun `sun_*`; location `loc_*`; soft states `st_*`; rule groups `rg_*`; agents `agent_*`.
- Time facts: `glob_time_hour`, `glob_time_minutes` (since midnight), `glob_time_day`, `glob_time_minute_of_week`. Sun: `sun_altitude`, `sun_azimuth` (degrees), `sun_is_daylight`, `sun_sunrise_minutes`, `sun_sunset_minutes`.
- Rule priorities: higher number runs first.
- Get exact live ids/tags from `GET /bms/context` — never guess; unknown facts make dead rules.
