---
description: Create or modify BMS automation rules from a natural-language request
argument-hint: <what the automation should do>
---

Implement this BMS automation request: **$ARGUMENTS**

Method (no copy/paste, work directly against the live system):

1. Read `docs/BMS_CONFIG_SCHEMA.md` for the config schema, operators, event types, and the critical patterns (hysteresis stage-checks, minute-of-week timers).
2. `curl -s http://127.0.0.1:1880/bms/context` — get exact point ids, tags, units, ranges, AND the current configuration. Never guess an id.
3. Design the config as a **minimal diff**: re-send the existing sections with your additions/changes merged in (a section you POST replaces that section entirely; sections you omit stay untouched). Reuse existing states/groups where sensible. If the request is ambiguous (which zones? thresholds? schedule?), ask before applying.
4. `curl -s -X POST http://127.0.0.1:1880/bms/config -H "Content-Type: application/json" -d @<tmpfile>` — apply. The response lists `unknownFacts`: if any, fix and re-apply; rules referencing them never fire.
5. Verify, don't assume: wait ~3s, then `curl -s http://127.0.0.1:1880/bms/firelog` — confirm the new rules are loaded and fire when expected. If a rule should only fire under conditions not currently true, prove the trigger with a sensor override: `curl -s -X POST http://127.0.0.1:1880/bms/points -d '{"id":"<sensor>","value":<v>,"simulate":true}'`, watch the firelog, then let physics restore the value.
6. Report: what was added/changed, verification evidence (rule names + fired timestamps), and any dashboard widgets you added.
