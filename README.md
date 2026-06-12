# AI_BMS — AI-Driven Building Management System (Node-RED)

A proof-of-concept BMS where automation logic is configured in **natural language**: an LLM converts user intent into a JSON configuration that is hot-loaded into a Node-RED runtime (rules engine, soft states, dynamic dashboard), simulating a 3-floor office building with 86 BACnet-style data points. Since V12.1 the system also exposes a **BMS HTTP API** so AI tooling (Claude Code) reads context, applies configuration, and verifies rule execution directly — no copy/paste.

## Start here

| Document | Purpose |
|---|---|
| [`handover/AI_BMS_Project_Handover.md`](handover/AI_BMS_Project_Handover.md) | **Architecture authority** — data structures, flow map, installation, roadmap. Read this first. |
| [`audit/2026-06-12_audit.md`](audit/2026-06-12_audit.md) | Full system audit — current issue list with fix statuses (P0/P1 fixed, P2 open). |
| [`docs/BMS_CONFIG_SCHEMA.md`](docs/BMS_CONFIG_SCHEMA.md) | Canonical AI-config schema + BMS HTTP API reference. |
| [`handover/AI_BMS_BOOTSTRAP_PROMPT.md`](handover/AI_BMS_BOOTSTRAP_PROMPT.md) | First message for a new AI instance taking over the project. |
| [`CLAUDE.md`](CLAUDE.md) | Auto-loaded context for Claude Code sessions (daily workflow). |
| [`docs/AI_BMS_history.md`](docs/AI_BMS_history.md) | Historical V8 documentation — background only, superseded. |

## Repository contents

| Path | Role |
|---|---|
| `flows.json` | The complete Node-RED flow — the system itself (tab "AI BMS V12 (Physics Simulator)", 83 nodes / 10 groups incl. the BMS API). |
| `settings.js` | Node-RED configuration **with secrets stripped** (functionGlobalContext modules, contextStorage persistence, adminAuth skeleton). |
| `package.json` / `package-lock.json` | npm dependencies of the Node-RED user directory. |
| `.mcp.json` | Node-RED MCP server configuration for Claude Code (project scope; needs `NODE_RED_TOKEN` env var). |
| `.claude/commands/` | Slash commands: `/bms-status`, `/bms-apply`, `/bms-debug`, `/bms-simulate`. |
| `handover/`, `audit/`, `docs/` | Documentation (see table above). |

**Not in the repo (gitignored, by design):** `flows_cred.json` (encrypted credentials), `.config.runtime.json` (credential decryption secret), runtime state, backups, `node_modules`.

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

## The BMS HTTP API (V12.1)

Base `http://127.0.0.1:1880/bms` — full reference in [`docs/BMS_CONFIG_SCHEMA.md`](docs/BMS_CONFIG_SCHEMA.md):

```bash
curl -s http://127.0.0.1:1880/bms/context    # live inventory + current config
curl -s -X POST http://127.0.0.1:1880/bms/config -H "Content-Type: application/json" -d @config.json
curl -s http://127.0.0.1:1880/bms/firelog    # are my rules loaded AND firing?
curl -s "http://127.0.0.1:1880/bms/points?tag=floor1"
curl -s -X POST http://127.0.0.1:1880/bms/points -d '{"id":"f1_lobby_motion","value":true,"simulate":true}'
```

Open on localhost (like the dashboard); set `BMS_API_TOKEN` in the Node-RED environment to require an `x-bms-token` header.

## ⚠️ Security info to add after cloning

`settings.js` ships with placeholders that **must** be filled in before the instance is usable:

1. **Admin password** — `adminAuth.users[0].password`: replace `REPLACE_WITH_BCRYPT_HASH` with the output of:
   ```bash
   node-red admin hash-pw
   ```
2. **Static API token** — `adminAuth.tokens[0].token`: replace `REPLACE_WITH_STATIC_API_TOKEN` with a long random string (e.g. `openssl rand -hex 32`). This token is what the Node-RED MCP server uses to call the Admin API — set the same value in `NODE_RED_TOKEN` for the MCP server.
3. **OpenWeatherMap API key** — not stored in this repo. After importing the flow, open the **OpenWeatherMap** node (group *WEATHER INTEGRATION*) and enter your key; Node-RED stores it encrypted in `flows_cred.json` locally.
4. *(Optional but recommended)* set an explicit `credentialSecret` in `settings.js` so `flows_cred.json` survives machine migrations; keep that secret out of git.

## Working with Claude Code

```bash
cd <this repo>
claude
```

`CLAUDE.md` auto-loads the workflow. For rules/automation work, just describe what you want — or use the slash commands:

- `/bms-status` — what's configured and firing right now
- `/bms-apply <request>` — design + apply + verify an automation from natural language
- `/bms-debug <symptom>` — root-cause a misbehaving automation
- `/bms-simulate <scenario>` — drive sensors to demo a cause-and-effect chain

For a brand-new AI instance (fresh takeover), paste `handover/AI_BMS_BOOTSTRAP_PROMPT.md` as the first message.
