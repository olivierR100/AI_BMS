'use strict';
/*
 * Restauration de la configuration persistée
 *
 * Agents, règles, états, widgets et réglages IA vivent dans le magasin de
 * contexte « file » et sont relus au démarrage.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installRestore(ctx) {
    const { global, node, env } = ctx;

// Restore AI configuration from the persistent 'file' context store (survives restarts)
const persistedKeys = ['ruleGroups', 'stateRegistry', 'behaviorAgents', 'dashboardConfig'];
const restored = [];
persistedKeys.forEach(k => {
    if (global.get(k) === undefined || global.get(k) === null) {
        let v;
        try { v = global.get(k, 'file'); } catch (e) { /* file store not configured in settings.js */ }
        if (v !== undefined && v !== null) { global.set(k, v); restored.push(k); }
    }
});
if (restored.length > 0) node.warn('✓ Restored persisted AI config: ' + restored.join(', '));

// Initialize empty AI config stores
if (!global.get('ruleGroups')) global.set('ruleGroups', []);
if (!global.get('stateRegistry')) global.set('stateRegistry', []);
if (!global.get('behaviorAgents')) global.set('behaviorAgents', []);
if (!global.get('dashboardConfig')) global.set('dashboardConfig', { widgets: [] });

// Restore AI chat settings from the persistent store, then migrate to the
// multi-provider shape: { provider, keys:{anthropic,openai,deepseek}, models:{...} }
let savedChat; try { savedChat = global.get('aiChatSettings', 'file'); } catch (e) { /* file store not configured */ }
if (savedChat && !global.get('aiChatSettings')) global.set('aiChatSettings', savedChat);

(function migrateChatSettings() {
    let s = global.get('aiChatSettings') || {};
    let changed = false;
    if (!s.keys) {
        // legacy { apiKey, model } -> per-provider maps (legacy key was always Anthropic)
        s = {
            provider: 'anthropic',
            keys: { anthropic: s.apiKey || '', openai: '', deepseek: '', mistral: '' },
            models: { anthropic: s.model || 'claude-sonnet-4-6', openai: 'gpt-5.1', deepseek: 'deepseek-v4-flash', mistral: 'mistral-large-latest' }
        };
        changed = true;
    }
    if (s.reasoning === undefined) { s.reasoning = 'off'; changed = true; }   // thinking-mode effort: off|high|max
    // backfill providers added later (e.g. mistral) onto existing saved settings
    if (s.keys && s.keys.mistral === undefined) { s.keys.mistral = ''; changed = true; }
    if (s.models && !s.models.mistral) { s.models.mistral = 'mistral-large-latest'; changed = true; }
    // migrate retired-default model alias to the V4 default
    if (s.models && (s.models.deepseek === 'deepseek-chat' || !s.models.deepseek)) { s.models.deepseek = 'deepseek-v4-flash'; changed = true; }
    if (changed) {
        global.set('aiChatSettings', s);
        try { global.set('aiChatSettings', s, 'file'); } catch (e) { /* file store not configured */ }
    }
})();
};
