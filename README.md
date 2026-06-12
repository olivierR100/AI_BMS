# AI_BMS — AI-Driven Building Management System (Node-RED)

A proof-of-concept BMS where automation logic is configured in **natural language**: an LLM converts user intent into a JSON configuration that is hot-loaded into a Node-RED runtime (rules engine, soft states, dynamic dashboard), simulating a 3-floor office building with 93 BACnet-style data points.

## Start here

| Document | Purpose |
|---|---|
| [`handover/AI_BMS_Project_Handover.md`](handover/AI_BMS_Project_Handover.md) | **Authoritative reference** — architecture, data structures, AI exchange schema, installation, known issues, roadmap. Read this first. |
| [`handover/AI_BMS_BOOTSTRAP_PROMPT.md`](handover/AI_BMS_BOOTSTRAP_PROMPT.md) | First message to give a new AI instance (Claude Code) taking over the project. |
| [`CLAUDE.md`](CLAUDE.md) | Auto-loaded context for Claude Code sessions. |

## Repository contents

| File | Role |
|---|---|
| `flows.json` | The complete Node-RED flow — the system itself (tab "AI BMS V12 (Physics Simulator)"). |
| `settings.js` | Node-RED configuration **with secrets stripped** (see below). Contains the required `functionGlobalContext` modules and `adminAuth` skeleton. |
| `package.json` / `package-lock.json` | npm dependencies of the Node-RED user directory. |
| `.mcp.json` | Node-RED MCP server configuration for Claude Code (project scope). |
| `handover/` | Transfer documentation (see table above). |

**Not in the repo (gitignored, by design):** `flows_cred.json` (encrypted credentials), `.config.runtime.json` (contains the credential decryption secret), `.config.*`/`.sessions.json` (runtime state), backups, `node_modules`.

## Installation (fresh machine)

Full procedure in the handover doc §2. Summary:

```bash
# WSL2 / Ubuntu, Node.js 18+
sudo npm install -g --unsafe-perm node-red
mkdir -p ~/.node-red && cd ~/.node-red
# copy flows.json, settings.js, package.json, package-lock.json from this repo
npm install
node-red
```

Editor: `http://127.0.0.1:1880` — Dashboard: `http://127.0.0.1:1880/dashboard/`

## ⚠️ Security info to add after cloning

`settings.js` ships with placeholders that **must** be filled in before the instance is usable:

1. **Admin password** — `adminAuth.users[0].password`: replace `REPLACE_WITH_BCRYPT_HASH` with the output of:
   ```bash
   node-red admin hash-pw
   ```
2. **Static API token** — `adminAuth.tokens[0].token`: replace `REPLACE_WITH_STATIC_API_TOKEN` with a long random string (e.g. `openssl rand -hex 32`). This token is what the Node-RED MCP server uses to call the Admin API — set the same value in the MCP server config / environment.
3. **OpenWeatherMap API key** — not stored in this repo at all. After importing the flow, open the **OpenWeatherMap** node (group *WEATHER INTEGRATION*) and enter your key; Node-RED stores it encrypted in `flows_cred.json` locally.
4. *(Optional but recommended)* set an explicit `credentialSecret` in `settings.js` so `flows_cred.json` survives machine migrations; keep that secret out of git (env var or local-only file).

## Working with Claude Code

```bash
cd <this repo>
claude
```

`CLAUDE.md` points the session at the handover documents; paste `handover/AI_BMS_BOOTSTRAP_PROMPT.md` as the first message of an initial takeover session. Working agreements (full code per named module for small fixes; full flow JSON for larger changes) are defined in the handover doc §9.
