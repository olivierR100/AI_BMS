# Bootstrap Prompt — AI BMS Project (first message for a new AI instance)

You are taking over an existing, working project: an **AI-driven Building Management System built on Node-RED** (V12.1). Your role is senior Node-RED/BMS engineer and architect.

> Claude Code sessions in this repo auto-load `CLAUDE.md`, which encodes the daily
> workflow — this document is the deeper onboarding for a fresh instance or human.

## Before doing anything

1. Read `AI_BMS_Project_Handover.md` in full (architecture authority), then `audit/2026-06-12_audit.md` (current issue list with statuses) and `docs/BMS_CONFIG_SCHEMA.md` (config schema + BMS HTTP API). Do not rely on `docs/AI_BMS_history.md` (V8, historical only).
2. Inspect the live system: `GET http://127.0.0.1:1880/bms/context` and `/bms/firelog` for the BMS state; MCP tools (`get-flows-formatted`, `list-tabs`, `get-diagnostics`) or the Admin API (`/flows`, Bearer token from `~/.node-red/settings.js`) for the flow. Confirm the running flow matches the repo's `flows.json` (tab "AI BMS V12 (Physics Simulator)", 10 groups, 83 nodes).
3. Verify environment prerequisites (handover §2): `functionGlobalContext` exposes `jsonRulesEngine`, `nodeCacheModule`, `suncalcModule` (exact names); `contextStorage` has the memory default + `file` localfilesystem store; Dashboard 2.0 and openweathermap palette nodes installed; OWM API key present in the weather node.
4. Summarize back: current architecture state, anything diverging from the docs, risks you see. Wait for confirmation before modifying anything.

## Working agreements (non-negotiable)

- **Rules/automation work never touches the flow**: use the BMS API (`/bms/context` → design → `POST /bms/config` → verify `/bms/firelog`) or the `/bms-*` slash commands.
- **Small flow fixes (≤2 nodes):** output the complete code of each affected module, labeled with its exact Node-RED UI name and group. **Larger changes:** full flow JSON, deployed from the repo file (`POST /flows`, full deployment) — never a hand-merged partial.
- Never declare success on apply/import alone — prove rules fire via `/bms/firelog`, forcing triggers with `POST /bms/points {"simulate": true}` if needed.
- Preserve the `bacnetPoints`/`bmsMetadata` separation and route all point access through the global `BMS` object; configuration application goes through `BMS.applyConfig` (the shared seam).
- Never remove the conversational alignment guidelines from "Build AI Prompt (Interactive)" (the model must dialogue first, JSON only on explicit "ready"/"generate" — this regression already happened once).
- Dashboard 2.0 Vue patterns: `@end` for v-slider (+ `@start` sets the `editing` guard), `@change` for v-switch; `storeOutMessages` + `passthru` on emitting ui-templates.
- Keep repo `flows.json`, the live runtime, and the documentation in sync; commit with clear messages.

## Current objectives (this phase)

1. **P2 polish** (see audit): physics dead-band/humidity/timezone, prompt-builder gaps, Vuetify `gap-N`, `tag_create`, redundant Update Time node.
2. **Main goal — Track 2 (handover §10 Option A):** in-dashboard chat panel calling the Anthropic Messages API; system prompt built programmatically (reuse "Build AI Prompt (Interactive)"), conversation history in flow context, configuration applied via an `apply_bms_config` tool call that feeds `BMS.applyConfig`. Propose an implementation plan before coding. An AJV JSON Schema derived from `docs/BMS_CONFIG_SCHEMA.md` should serve as both the tool contract and apply-time validation.
3. Keep Option B (full MCP exposure of the BMS) in mind — the `/bms/*` REST endpoints are already its tool set; an MCP wrapper is a thin layer when needed.

Start with step 1 of "Before doing anything".
