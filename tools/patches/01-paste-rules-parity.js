'use strict';
/*
 * Patch — met pasteRules au niveau de toolRules.
 *
 * Le mode « paste » (page AI Configuration, pour un assistant externe)
 * n'enseignait ni merge, ni les suppressions, ni ttl : tout assistant utilisant
 * ce chemin ne pouvait que remplacer des sections entières, donc détruire la
 * configuration existante à chaque édition.
 *
 * Les règles conversationnelles d'origine sont conservées mot pour mot :
 * elles sont non négociables (cf. CLAUDE.md).
 */

const fk = require('../flowkit');

const flows = fk.load();
const init = fk.node(flows, 'Initialize System (V12)');

const START = 'const pasteRules = `';
const END = '\nconst toolRules';

const from = init.func.indexOf(START);
if (from === -1) throw new Error('pasteRules introuvable');
const to = init.func.indexOf(END, from);
if (to === -1) throw new Error('fin de pasteRules introuvable');

const current = init.func.slice(from, to);
if (current.length > 1200) {
    throw new Error(`pasteRules fait déjà ${current.length} caractères — patch probablement déjà appliqué`);
}

// Les fences markdown doivent rester échappées : le tout vit dans un template
// literal du code du nœud.
const F = '\\`\\`\\`';

const replacement = `const pasteRules = \`# INTERACTION RULES (CRITICAL)
1. When no rules exist: Have a friendly conversation. Ask what automations they want (lighting? climate? schedules?). Suggest 2-3 common scenarios briefly.
2. When rules exist: Summarize current logic in plain English, then ask what to change.
3. Keep responses concise and conversational - no JSON structures, no machine-formatted summaries.
4. Only output the final JSON block (updated rule_groups, states and dashboard) when user confirms they're ready.

# OUTPUT FORMAT (Single JSON Object)
${F}json
{
  "merge": true,
  "behavior_agents": [...],
  "defined_states": [...],
  "rule_groups": [...],
  "dashboard": { "widgets": [...] }
}
${F}

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
${F}json
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
${F}
Use "replace": true on a group to swap all of its rules at once.
When you delete an agent, delete its rule group as well (and the reverse) — an orphan of
either leaves dead configuration behind.

# SOFT STATE EXPIRY
defined_states accept an optional "ttl" in seconds. The state falls back to its defaultValue
once the ttl elapses without being written again. This is how timers and latches are built,
for example an occupancy hold that releases itself.\``;

init.func = init.func.slice(0, from) + replacement + init.func.slice(to);
fk.save(flows);

const check = init.func.slice(init.func.indexOf(START), init.func.indexOf(END));
for (const token of ['merge', 'remove_agents', 'remove_rules', '"remove": true', 'ttl', 'replace']) {
    if (!check.includes(token)) throw new Error(`token manquant après patch : ${token}`);
}
console.log(`pasteRules : ${current.length} → ${check.length} caractères`);
console.log('tokens vérifiés : merge, remove_agents, remove_rules, remove:true, ttl, replace');
