'use strict';
/*
 * Abstraction BMS — le point de passage unique vers les points
 *
 * Tout accès à un point et toute application de configuration passent par cet
 * objet. C'est la couture que la future couche pilote (BACnet) remplacera.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

const { createRegistry } = require('./drivers');
const { analyseConfig } = require('./analyse');
const { createSafety } = require('./safety');

module.exports = function installBms(ctx) {
    const { global, node, env } = ctx;

// Couche pilote : le simulateur est le seul pilote enregistré aujourd'hui.
// Un pilote BACnet viendra s'enregistrer ici, et la sélection se fera point par
// point via le contexte `pointDrivers` — pas d'un seul bloc pour le bâtiment.
global.set('ioDrivers', createRegistry(ctx));

// Enveloppe de sécurité : traçabilité, cadence, approbation. Sans effet tant
// que tous les points sont simulés et qu'aucune limite n'est configurée.
const safety = createSafety(ctx);
global.set('bmsSafety', safety);

// ========================================
// BMS ABSTRACTION LAYER
// ========================================
const BMS = {
    // Get all values as flat object for rules engine
    getValues: function() {
        const bp = global.get('bacnetPoints') || {};
        const vp = global.get('virtualPoints') || {};
        const result = {};
        
        // Add all bacnet point values
        Object.keys(bp).forEach(id => {
            result[id] = bp[id].value;
        });
        
        // Add all virtual point values
        Object.keys(vp).forEach(id => {
            result[id] = vp[id].value;
        });
        
        return result;
    },
    
    // Get single value
    // Horloge du système. Tout fait temporel (heure, minute de la semaine,
    // minuteurs d'occupation, position du soleil) passe par ici, afin que le
    // mode Démo/Test puisse accélérer le temps sans qu'aucune règle ne change.
    // Au multiplicateur 1 — le défaut — c'est strictement l'horloge réelle.
    now: function() {
        const c = global.get('demoClock');
        if (!c || !c.multiplier || c.multiplier === 1) return new Date();
        return new Date(c.anchorVirtual + (Date.now() - c.anchorReal) * c.multiplier);
    },

    getValue: function(id) {
        const bp = global.get('bacnetPoints') || {};
        const vp = global.get('virtualPoints') || {};
        if (bp[id] !== undefined) return bp[id].value;
        if (vp[id] !== undefined) return vp[id].value;
        return undefined;
    },
    
    // Write value (with safety checks)
    //
    // Reste SYNCHRONE : les 130 règles et les nœuds du flow l'appellent ainsi.
    // Un point confié à un pilote réel (BACnet) ne peut pas être écrit de façon
    // synchrone honnêtement — on refuse alors explicitement plutôt que de
    // renvoyer `true` sur une écriture qui n'a pas encore eu lieu. L'appelant
    // doit passer à writeValueAsync. Tant que tout est simulé, ce cas ne se
    // produit jamais et le comportement est inchangé.
    writeValue: function(id, value) {
        const bp = global.get('bacnetPoints') || {};
        const vp = global.get('virtualPoints') || {};

        if (bp[id]) {
            const io = global.get('ioDrivers');
            if (io && io.driverFor(id).name !== 'simulator') {
                if (node && node.warn) {
                    node.warn(`writeValue synchrone refusé sur ${id} : point piloté par ` +
                              `« ${io.driverFor(id).name} ». Utiliser BMS.writeValueAsync.`);
                }
                return false;
            }
            if (bp[id].access !== 'read_write') return false;
            if (bp[id].min !== undefined && value < bp[id].min) value = bp[id].min;
            if (bp[id].max !== undefined && value > bp[id].max) value = bp[id].max;

            const verdict = safety.allowChange(id, value, bp[id].value);
            if (!verdict.allowed) {
                if (node && node.warn) node.warn('⚠ ' + verdict.reason);
                safety.record(id, value, this._source || 'rule', { ok: false, error: verdict.reason });
                return false;
            }
            const changed = bp[id].value !== value;

            bp[id].value = value;
            global.set('bacnetPoints', bp);
            if (io) io.markWritten(id, 'simulator');
            // Ne journaliser que les changements : les règles réécrivent la même
            // valeur à chaque tick et noieraient la trace utile.
            if (changed) safety.record(id, value, this._source || 'rule', { ok: true });
            return true;
        }

        if (vp[id] && vp[id].writable) {
            if (vp[id].min !== undefined && value < vp[id].min) value = vp[id].min;
            if (vp[id].max !== undefined && value > vp[id].max) value = vp[id].max;
            vp[id].value = value;
            global.set('virtualPoints', vp);
            return true;
        }

        return false;
    },

    // Écriture asynchrone — la forme que toute écriture matérielle réelle doit
    // prendre. Passe par la couche pilote, rend { ok, value, error }.
    // `opts.priority` sera la priorité du tableau BACnet ; le simulateur
    // l'ignore.
    writeValueAsync: function(id, value, opts) {
        const bp = global.get('bacnetPoints') || {};
        const vp = global.get('virtualPoints') || {};
        const io = global.get('ioDrivers');

        if (bp[id]) {
            if (!io) return Promise.resolve({ ok: this.writeValue(id, value) });
            return io.write(id, value, opts || {});
        }

        if (vp[id]) {
            // Les points virtuels sont calculés localement : pas de pilote.
            return Promise.resolve({ ok: this.writeValue(id, value), value: vp[id].value });
        }

        return Promise.resolve({ ok: false, error: 'unknown point: ' + id });
    },

    // Fraîcheur et qualité d'un point : { quality, ts, ageMs, stale, source }.
    // Avec le simulateur rien n'est jamais périmé ; avec un contrôleur réel,
    // c'est ce qui distingue « 21 °C » de « 21 °C il y a deux heures, avant que
    // l'automate ne cesse de répondre ».
    getStatus: function(id) {
        const io = global.get('ioDrivers');
        if (!io) return { quality: 'unknown', ts: null, ageMs: null, stale: false, source: null };
        return io.statusOf(id);
    },

    isStale: function(id) {
        return this.getStatus(id).stale === true;
    },
    
    // Set virtual point value directly (for computed values)
    setVirtualValue: function(id, value) {
        const vp = global.get('virtualPoints') || {};
        if (vp[id]) {
            vp[id].value = value;
            global.set('virtualPoints', vp);
            return true;
        }
        return false;
    },
    
    // Get metadata for a point
    getMetadata: function(id) {
        const meta = global.get('bmsMetadata') || {};
        return meta[id] || null;
    },

    // Apply an AI configuration object (single seam used by the Import Panel,
    // the /bms/config HTTP API, and future tool-calling integrations).
    // Validates fact references, applies present sections to runtime context,
    // and mirrors them to the persistent 'file' store.
    applyConfig: function(cfg) {
        const result = { applied: [], counts: {}, unknownFacts: [], errors: [] };
        if (!cfg || typeof cfg !== 'object') {
            result.errors.push('config must be a JSON object');
            return result;
        }

        // Portail d'approbation : une configuration qui commande du matériel
        // réel ne s'applique pas sur la seule foi d'une conversation. Sans
        // point réel — le cas tant que tout est simulé — ceci ne fait rien.
        const approval = safety.checkApproval(cfg);
        if (!approval.approved) {
            result.errors.push(approval.message);
            result.pendingApproval = { realPoints: approval.realPoints };
            return result;
        }
        if (approval.realPoints.length > 0) result.approvedRealPoints = approval.realPoints;

        // Analyse statique : une configuration peut être valide et pourtant
        // pathologique. Les avertissements ne bloquent pas — ils remontent dans
        // le résultat, donc jusqu'à l'assistant IA via le résultat d'outil.
        try {
            result.warnings = analyseConfig(cfg, {
                bmsMetadata: global.get('bmsMetadata'),
                stateRegistry: global.get('stateRegistry'),
                ruleGroups: global.get('ruleGroups'),
            });
        } catch (e) {
            result.warnings = [];
            if (node && node.warn) node.warn('analyse statique en échec : ' + e.message);
        }

        const knownFacts = new Set(Object.keys(BMS.getValues()));
        (global.get('stateRegistry') || []).forEach(s => knownFacts.add(s.id));
        (cfg.defined_states || []).forEach(s => knownFacts.add(s.id));
        const factOps = ['lessThanFact', 'greaterThanFact', 'equalFact', 'notEqualFact', 'lessThanInclusiveFact', 'greaterThanInclusiveFact'];
        const unknown = new Set();
        function checkConds(c) {
            if (!c) return;
            (c.all || c.any || []).forEach(sub => {
                if (sub.all || sub.any) return checkConds(sub);
                if (sub.fact && !knownFacts.has(sub.fact)) unknown.add(sub.fact);
                if (factOps.includes(sub.operator)) {
                    const cmp = (sub.value && typeof sub.value === 'object') ? sub.value.fact : sub.value;  // {fact,add} deadband or fact id
                    if (typeof cmp === 'string' && !knownFacts.has(cmp)) unknown.add(cmp);
                }
            });
        }
        (cfg.rule_groups || []).forEach(g => (g.rules || []).forEach(r => checkConds(r.conditions)));
        result.unknownFacts = [...unknown];

        function applyKey(key, value) {
            global.set(key, value);
            try { global.set(key, value, 'file'); } catch (e) { /* file store not configured */ }
        }

        // merge mode (cfg.merge=true): upsert the list sections by id instead of replacing the
        // whole section. Lets the model apply a large ruleset in several SMALL tool calls (one
        // batch per call) without dropping earlier batches — the workaround for the output-token
        // cap. Default (no merge): each provided section replaces its entire prior contents.
        const merge = cfg.merge === true;
        result.merge = merge;
        function upsert(existing, incoming) {
            const byId = {};
            (existing || []).forEach(x => { if (x && x.id) byId[x.id] = x; });
            (incoming || []).forEach(x => { if (x && x.id) byId[x.id] = x; });
            return Object.keys(byId).map(k => byId[k]);
        }

        function removeByIds(arr, ids) { return (arr || []).filter(x => ids.indexOf(x && x.id) === -1); }

        if (cfg.behavior_agents) {
            const v = merge ? upsert(global.get('behaviorAgents'), cfg.behavior_agents) : cfg.behavior_agents;
            applyKey('behaviorAgents', v);
            result.applied.push('behavior_agents');
            result.counts.agents = v.length;
        }
        if (cfg.rule_groups) {
            let groups;
            if (merge) {
                // Granular rule-level merge: upsert groups by id, and WITHIN an existing group
                // upsert rules by name (+ remove_rules, + group.replace, + group.remove). Lets the
                // model edit one rule without re-sending all of a group's rules.
                const byId = {};
                (global.get('ruleGroups') || []).forEach(g => { byId[g.id] = JSON.parse(JSON.stringify(g)); });
                cfg.rule_groups.forEach(inc => {
                    if (!inc || !inc.id) return;
                    if (inc.remove === true) { delete byId[inc.id]; return; }
                    const cur = byId[inc.id];
                    if (!cur || inc.replace === true) {
                        const ng = { id: inc.id, name: inc.name || (cur && cur.name) || inc.id, rules: inc.rules || [] };
                        if (inc.enabled !== undefined) ng.enabled = inc.enabled;
                        byId[inc.id] = ng;
                    } else {
                        if (inc.name) cur.name = inc.name;
                        if (inc.enabled !== undefined) cur.enabled = inc.enabled;
                        cur.rules = cur.rules || [];
                        const idxByName = {};
                        cur.rules.forEach((r, i) => { idxByName[r.name] = i; });
                        (inc.rules || []).forEach(r => {
                            if (r.name && idxByName[r.name] !== undefined) cur.rules[idxByName[r.name]] = r;
                            else cur.rules.push(r);
                        });
                        if (inc.remove_rules && inc.remove_rules.length) cur.rules = cur.rules.filter(r => inc.remove_rules.indexOf(r.name) === -1);
                    }
                });
                groups = Object.keys(byId).map(k => byId[k]);
            } else {
                groups = cfg.rule_groups;
            }
            applyKey('ruleGroups', groups);
            result.applied.push('rule_groups');
            result.counts.groups = groups.length;
            result.counts.rules = groups.reduce((s, g) => s + (g.rules || []).length, 0);
        }
        if (cfg.defined_states) {
            const v = merge ? upsert(global.get('stateRegistry'), cfg.defined_states) : cfg.defined_states;
            applyKey('stateRegistry', v);
            result.applied.push('defined_states');
            result.counts.states = v.length;
        }
        if (cfg.dashboard) {
            // merge: upsert top-level widgets by id (append id-less ones), else replace
            let dash = cfg.dashboard;
            if (merge) {
                const cur = (global.get('dashboardConfig') || { widgets: [] }).widgets || [];
                const out = cur.slice();
                const idx = {}; out.forEach((w, i) => { if (w && w.id) idx[w.id] = i; });
                (cfg.dashboard.widgets || []).forEach(w => {
                    if (w && w.id && idx[w.id] !== undefined) out[idx[w.id]] = w;
                    else out.push(w);
                });
                dash = { widgets: out };
            }
            applyKey('dashboardConfig', dash);
            result.applied.push('dashboard');
            result.counts.widgets = (dash.widgets || []).length;
        }
        // top-level removals (merge or not): remove_agents/remove_states/remove_widgets = [ids]
        if (cfg.remove_agents && cfg.remove_agents.length) { applyKey('behaviorAgents', removeByIds(global.get('behaviorAgents'), cfg.remove_agents)); result.applied.push('removed_agents'); }
        if (cfg.remove_states && cfg.remove_states.length) { applyKey('stateRegistry', removeByIds(global.get('stateRegistry'), cfg.remove_states)); result.applied.push('removed_states'); }
        if (cfg.remove_widgets && cfg.remove_widgets.length) {
            const cur = (global.get('dashboardConfig') || { widgets: [] }).widgets || [];
            applyKey('dashboardConfig', { widgets: cur.filter(w => cfg.remove_widgets.indexOf(w && w.id) === -1) });
            result.applied.push('removed_widgets');
        }
        return result;
    }
};

global.set('BMS', BMS);

// Horloge Démo/Test. Seul le multiplicateur survit au redémarrage : les ancres
// sont reprises maintenant, pour que l'horloge virtuelle reparte du temps réel.
let demoMultiplier = 1;
try {
    const persistedMultiplier = global.get('demoClockMultiplier', 'file');
    if (typeof persistedMultiplier === 'number' && persistedMultiplier > 0) demoMultiplier = persistedMultiplier;
} catch (e) { /* file store not configured */ }
global.set('demoClock', { multiplier: demoMultiplier, anchorReal: Date.now(), anchorVirtual: Date.now() });
if (demoMultiplier !== 1) node.warn('⏩ Demo/Test mode actif au démarrage : temps ×' + demoMultiplier);
};
