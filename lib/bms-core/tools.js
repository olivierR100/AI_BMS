'use strict';
/*
 * Définitions d'outils pour l'assistant IA embarqué
 *
 * read_config et apply_bms_config : le contrat que le modèle voit.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installTools(ctx) {
    const { global, node, env } = ctx;

// Tool definitions for the in-dashboard AI chat (Anthropic tool-use). The chat prompt carries
// only a COMPACT index of the current config (ids/names) to save tokens; the model uses
// read_config to fetch exact definitions on demand, and apply_bms_config (merge) to edit
// granularly without re-sending everything.
global.set('aiChatTools', [{
    name: 'read_config',
    description: 'Read the EXACT current definition of part of the live config (the chat prompt only lists ids/names). Call this before editing existing rules so you can preserve/modify them precisely. Returns the requested slice as JSON.',
    input_schema: {
        type: 'object',
        properties: {
            section: { type: 'string', enum: ['rule_groups', 'defined_states', 'behavior_agents', 'dashboard'], description: 'which section to read' },
            id: { type: 'string', description: 'optional: a single rule_group id (for section=rule_groups) to read just that group' }
        },
        required: ['section']
    }
}, {
    name: 'apply_bms_config',
    description: 'Apply a BMS configuration. Default: each provided section REPLACES that section. With merge:true it edits GRANULARLY without dropping the rest: behavior_agents/defined_states upsert by id; rule_groups upsert by id AND within an existing group its rules upsert by NAME (so you can add/change ONE rule without re-sending the others). Per rule_group you may also set replace:true (replace all its rules), remove:true (delete the group), or remove_rules:[names]. Top-level remove_agents/remove_states/remove_widgets:[ids] delete items. Dashboard widgets upsert by id. PREFER merge for edits to a large config so each call stays small/under the token limit. Returns {applied, counts, unknownFacts, errors}; fix any unknownFacts and call again.',
    input_schema: {
        type: 'object',
        properties: {
            merge: { type: 'boolean', description: 'true = granular upsert/edit; false/omitted = replace each provided section' },
            behavior_agents: { type: 'array', items: { type: 'object' }, description: 'Agents: {id, name, description, category, enabled, rule_group}' },
            defined_states: { type: 'array', items: { type: 'object' }, description: 'Soft states: {id, name, type, defaultValue, ttl?, description}' },
            rule_groups: { type: 'array', items: { type: 'object' }, description: 'Groups: {id, name, rules:[{name, conditions, event, priority?}], replace?, remove?, remove_rules?:[names]}' },
            dashboard: { type: 'object', description: '{widgets:[...]}' },
            remove_agents: { type: 'array', items: { type: 'string' } },
            remove_states: { type: 'array', items: { type: 'string' } },
            remove_widgets: { type: 'array', items: { type: 'string' } }
        }
    }
}]);
};
