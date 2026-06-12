---
description: Diagnose why a BMS automation isn't behaving as expected
argument-hint: <symptom, e.g. "lobby lights never turn off">
---

Debug this BMS symptom: **$ARGUMENTS**

Work the chain Sense → Think → Act against the live system (http://127.0.0.1:1880):

1. `GET /bms/firelog` — is the relevant rule loaded? Enabled? When did it last fire? (Engine evaluates every 1 s; a rule whose conditions hold fires every tick.)
2. `GET /bms/points` — pull the facts the rule's conditions reference and evaluate them by hand against the rule JSON (from `GET /bms/context` → `config.rule_groups`). Identify the exact blocking condition. Soft states (`st_*`) are included — check TTL expiry (state silently reverts to defaultValue).
3. Common causes from the audit: unknown/typo'd fact id (rule silently dead — `POST /bms/config` reports these), missing stage-check causing every-tick refiring, hysteresis thresholds without a gap, timer comparison against `glob_time_minute_of_week` wrapping at week end, `control_group` unit filter matching zero actuators (check tag + units), value clamped by point min/max.
4. Reproduce: force the trigger with `POST /bms/points {"id":..., "value":..., "simulate":true}` and watch the firelog and target actuator value. Remember physics drifts overridden sensors back within seconds — check immediately after the override.
5. If the engine itself looks dead (nothing fires at all): check the Node-RED log and the JSON Rules Engine node status; `GET /bms/firelog` `rulesLoaded` of 0 with groups present means rule-format errors (see node warnings).

Report the root cause, evidence, and the fix (as a config diff if it's a rules problem). Apply the fix only if asked, or if the user request was clearly "fix it".
