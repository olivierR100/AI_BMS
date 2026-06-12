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

### Node-RED MCP Server — setup & secrets

Claude Code edits the live flows through [`node-red-mcp-server`](https://github.com/karavaev-evgeniy/node-red-mcp-server), an MCP bridge to the Node-RED Admin API (tools: `get-flows`, `update-flows`, `inject`, `list-tabs`, `search-nodes`, `get-diagnostics`, …). It is declared at **project scope** in [`.mcp.json`](.mcp.json) (committed), and authenticates with a static API token that is **never committed** — the config references the `NODE_RED_TOKEN` environment variable instead.

#### One-time setup on a new machine

**1. Generate the token** (any long random string; hex avoids quoting issues):

```bash
openssl rand -hex 32
```

**2. Declare it in `~/.node-red/settings.js`** — the same token, under `adminAuth`:

```js
adminAuth: {
    type: "credentials",
    users: [{ username: "admin", password: "<bcrypt hash>", permissions: "*" }],
    tokens: [
        { token: "<paste the generated token>", user: "admin", scope: ["*"] }
    ]
},
```

(The repo's `settings.js` ships with a `REPLACE_WITH_STATIC_API_TOKEN` placeholder at this exact spot.)

**3. Export it in your WSL shell profile** — same value again:

```bash
echo 'export NODE_RED_TOKEN="<paste the generated token>"' >> ~/.bashrc
source ~/.bashrc
```

> Tip: if pasting into the terminal leaves you at a `>` continuation prompt, a quote got mangled — press Ctrl-C and retype, or edit `~/.bashrc` with nano instead.

**4. Restart Node-RED** so `settings.js` is re-read, then verify the Admin API accepts the token:

```bash
pm2 restart node-red     # or stop/start your foreground instance
curl -H "Authorization: Bearer $NODE_RED_TOKEN" http://127.0.0.1:1880/settings | head -c 200
```

A JSON response = OK. `401 Unauthorized` = the value in `settings.js` and the env var differ, or Node-RED wasn't restarted.

#### Registering the server (only if `.mcp.json` is absent)

The repo already contains `.mcp.json`, so cloning is normally enough. To recreate it:

```bash
claude mcp add --transport stdio --scope project node-red \
  --env NODE_RED_URL=http://127.0.0.1:1880 \
  --env NODE_RED_TOKEN='${NODE_RED_TOKEN}' \
  -- npx -y node-red-mcp-server
```

The single quotes are deliberate: they keep the literal `${NODE_RED_TOKEN}` in `.mcp.json`, which Claude Code expands from the environment at session start. The committed file must look like this — a placeholder, never a real token:

```json
{
  "mcpServers": {
    "node-red": {
      "command": "npx",
      "args": ["-y", "node-red-mcp-server"],
      "env": {
        "NODE_RED_URL": "http://127.0.0.1:1880",
        "NODE_RED_TOKEN": "${NODE_RED_TOKEN}"
      }
    }
  }
}
```

#### Verifying from Claude Code

```bash
cd <repo> && claude     # approve the project MCP server when prompted
```

In the session: `/mcp` should list **node-red — connected**; then ask it to run `list-tabs` — expected answer includes the tab `AI BMS V12 (Physics Simulator)`.

#### Secret rules & troubleshooting

- **Where each copy of the token lives:** real value in `~/.node-red/settings.js` (local only) and `~/.bashrc` (local only); placeholder in the committed `settings.js` and `.mcp.json`. Before any push: `git diff --cached` must show placeholders only.
- **Rotating the token:** regenerate (step 1), update `settings.js` + `~/.bashrc`, restart Node-RED, restart Claude Code. Rotate immediately if the token was ever pasted into a chat, issue, or log.
- **Claude Code can't see a token you just exported:** the environment is captured at launch. `/exit`, then `source ~/.bashrc`, then `claude --continue` to resume the same conversation with the new environment.
- **MCP tools fail but curl works:** check `/mcp` for the server status and confirm Node-RED is running (`pm2 status` / `pkill -0 -f node-red`).
