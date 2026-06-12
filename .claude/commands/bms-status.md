---
description: Live BMS health check — loaded config, rule fire activity, physics state
---

Report the live state of the BMS (Node-RED at http://127.0.0.1:1880).

1. `curl -s http://127.0.0.1:1880/bms/firelog` — agents, rule groups, rules loaded, per-rule last-fired times, physics_enabled.
2. `curl -s http://127.0.0.1:1880/bms/context` — summarize the applied config sections and how many points/tags exist.
3. Cross-check: every enabled agent's rule_group exists; every loaded rule has fired recently OR explain why it wouldn't (condition not met is fine — name the blocking condition using current values from `GET /bms/points`).

Report concisely: what's configured, what's firing, anything dead or misconfigured. If no config is loaded, say so plainly.
