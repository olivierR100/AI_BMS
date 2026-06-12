---
description: Drive a building scenario through the hardware simulation layer
argument-hint: <scenario, e.g. "someone enters the F1 meeting room and CO2 rises">
---

Simulate this scenario on the live BMS: **$ARGUMENTS**

1. `curl -s http://127.0.0.1:1880/bms/context` — find the exact sensor ids involved (motion, temp, co2, lux…) and check current values via `GET /bms/points`.
2. Drive the scenario with sensor overrides, in realistic order and values:
   `curl -s -X POST http://127.0.0.1:1880/bms/points -H "Content-Type: application/json" -d '{"id":"<sensor>","value":<v>,"simulate":true}'`
   Booleans for motion/occupancy; CO2 in ppm (450 baseline, ~1000 occupied, >1200 poor); lux 0–10000 indoor.
3. Observe the system react: `GET /bms/firelog` for rules firing, `GET /bms/points` for actuator responses (lamps, setpoints, ventilation).
4. Mind the physics simulator (2 s tick): it drifts overridden *sensors* back toward equilibrium — for a sustained condition (e.g. occupied room), re-assert the override or set the motion boolean which physics treats as occupancy input.
5. Narrate the cause-and-effect chain observed (sensor → rule → actuator), with values and timestamps. Restore anything you changed that won't drift back on its own.
