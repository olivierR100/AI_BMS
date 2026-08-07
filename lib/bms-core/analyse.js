'use strict';
/*
 * Analyse statique d'une configuration de règles.
 *
 * Pourquoi : une règle peut être parfaitement valide — faits connus, syntaxe
 * correcte, application sans erreur — et malgré tout pathologique. Le cas qui a
 * motivé ce module : « Business Hours → All Comfort », dont les conditions ne
 * portent que sur l'heure. Elles restent vraies douze heures d'affilée, donc la
 * règle se redéclenche à chaque cycle du moteur et réécrit douze consignes par
 * seconde. Rien ne la signalait.
 *
 * Ces contrôles tournent à chaque application de configuration, y compris
 * celles de l'assistant IA. Comme le résultat de `applyConfig` est renvoyé au
 * modèle dans le résultat d'outil, l'assistant voit ses propres défauts et peut
 * corriger dans le même tour — ce qui vaut mieux que d'allonger le prompt d'un
 * paragraphe de plus qu'il pourrait ignorer.
 *
 * Principe : ne signaler que ce qui est démontrable en lisant la configuration.
 * Un faux positif coûte plus cher qu'un silence, car il apprend à ignorer les
 * avertissements.
 */

/** Parcourt un arbre de conditions et renvoie tous les faits référencés. */
function factsInConditions(conditions, out) {
    out = out || new Set();
    if (!conditions || typeof conditions !== 'object') return out;

    for (const branch of ['all', 'any']) {
        for (const sub of conditions[branch] || []) {
            if (sub.all || sub.any) { factsInConditions(sub, out); continue; }
            if (sub.fact) out.add(sub.fact);
            // Opérateurs fait-à-fait : la comparaison porte aussi sur un fait.
            const cmp = (sub.value && typeof sub.value === 'object') ? sub.value.fact : sub.value;
            if (typeof cmp === 'string' && /^(f\d|st_|glob_|sun_|loc_)/.test(cmp)) out.add(cmp);
        }
    }
    return out;
}

/** Points portant une étiquette donnée. */
function pointsWithTag(metadata, tag) {
    return Object.entries(metadata || {})
        .filter(([, m]) => (m.tags || []).includes(tag))
        .map(([id]) => id);
}

/**
 * @param {object} cfg       configuration soumise
 * @param {object} context   { bmsMetadata, stateRegistry, ruleGroups } — l'état
 *                           courant, pour juger une configuration partielle
 * @returns {Array<{severity, code, rule, group, message, hint}>}
 */
function analyseConfig(cfg, context) {
    const warnings = [];
    const metadata = (context && context.bmsMetadata) || {};
    const groups = (cfg && cfg.rule_groups) || [];

    const add = (w) => warnings.push(w);

    // Cible(s) écrite(s) par un événement.
    const targetsOf = (event) => {
        const p = (event && event.params) || {};
        if (p.id) return [p.id];
        if (p.tag) return pointsWithTag(metadata, p.tag);
        return [];
    };

    const writesByTarget = new Map();   // cible → [{group, rule, value}]

    for (const group of groups) {
        if (group.remove === true) continue;

        for (const rule of group.rules || []) {
            const event = rule.event || {};
            const params = event.params || {};
            const targets = targetsOf(event);
            const conditionFacts = factsInConditions(rule.conditions);
            const where = { group: group.id, rule: rule.name };

            // ── 1. Règle de niveau sans garde d'idempotence ──────────────────
            // Aucune condition ne porte sur ce que la règle écrit : rien ne
            // l'arrête une fois la cible atteinte.
            const guarded = targets.some((t) => conditionFacts.has(t));
            const fanout = params.tag ? targets.length : 1;

            // Calibrage. Une règle qui réécrit sa cible sans condition sur
            // celle-ci n'est pas anormale : « présence → lampe allumée » est de
            // cette forme et se tait dès que la présence retombe, parce que sa
            // condition évolue d'elle-même. Signaler tous ces cas produisait
            // 136 avertissements sur la configuration de démonstration — du
            // bruit, qui apprend à ignorer les avertissements.
            //
            // Deux situations méritent réellement l'alerte :
            //   · conditions purement horaires — vraies des heures durant, donc
            //     la règle rejoue indéfiniment ;
            //   · diffusion large par étiquette — le coût est multiplié par le
            //     nombre de points touchés.
            const timeOnly = conditionFacts.size > 0 &&
                [...conditionFacts].every((f) => /^glob_time_|^sun_/.test(f));

            if (targets.length > 0 && !guarded && conditionFacts.size > 0 && (timeOnly || fanout > 3)) {
                add({
                    severity: (timeOnly && fanout > 3) ? 'high' : 'medium',
                    code: 'unguarded-rewrite',
                    ...where,
                    message: `« ${rule.name} » réécrit ${params.tag ? fanout + ' points (étiquette « ' + params.tag + ' »)' : '« ' + targets[0] + ' »'} ` +
                             `sans qu'aucune condition ne porte sur la valeur écrite. La règle se redéclenchera ` +
                             `à chaque cycle du moteur tant que ses conditions restent vraies` +
                             (fanout > 3 ? `, soit ${fanout} écritures par cycle.` : '.'),
                    hint: `Ajouter une condition d'arrêt, par exemple ` +
                          `{ "fact": "${targets[0]}", "operator": "notEqualFact", "value": ` +
                          `${params.value_from_fact ? '"' + params.value_from_fact + '"' : JSON.stringify(params.value)} }.`,
                });
            }

            // ── 3. Règle sans condition ──────────────────────────────────────
            if (targets.length > 0 && conditionFacts.size === 0) {
                add({
                    severity: 'high', code: 'unconditional-rule', ...where,
                    message: `« ${rule.name} » n'a aucune condition : elle s'exécutera à chaque cycle, indéfiniment.`,
                    hint: `Ajouter des conditions, ou supprimer la règle si elle sert de valeur par défaut ` +
                          `(dans ce cas, un defaultValue d'état convient mieux).`,
                });
            }

            for (const t of targets) {
                if (!writesByTarget.has(t)) writesByTarget.set(t, []);
                writesByTarget.get(t).push({
                    group: group.id, rule: rule.name, timeOnly,
                    value: params.value_from_fact ? 'fact:' + params.value_from_fact : JSON.stringify(params.value),
                    priority: rule.priority,
                });
            }
        }
    }

    // ── 4. Écrivains concurrents sur une même cible ─────────────────────────
    for (const [target, writers] of writesByTarget) {
        const distinct = new Set(writers.map((w) => w.value));
        const anyTimeOnly = writers.some((w) => w.timeOnly);
        if (writers.length > 1 && distinct.size > 1 && anyTimeOnly) {
            const sorted = [...writers].sort((a, b) => (b.priority || 0) - (a.priority || 0));
            add({
                severity: 'medium', code: 'competing-writers',
                group: sorted[0].group, rule: sorted[0].rule,
                message: `« ${target} » est écrit par ${writers.length} règles avec des valeurs différentes ` +
                         `(${sorted.map((w) => w.rule + ' → ' + w.value).join(' | ')}).`,
                hint: `Si leurs conditions peuvent être vraies en même temps, le résultat dépend de l'ordre ` +
                      `d'exécution. Rendre les conditions mutuellement exclusives, ou trancher par priority.`,
            });
        }
    }

    // ── 5. Cohérence agent ↔ groupe ─────────────────────────────────────────
    const groupIds = new Set([
        ...groups.filter((g) => g.remove !== true).map((g) => g.id),
        ...((context && context.ruleGroups) || []).map((g) => g.id),
    ]);
    for (const agent of (cfg && cfg.behavior_agents) || []) {
        if (agent.rule_group && !groupIds.has(agent.rule_group)) {
            add({
                severity: 'high', code: 'orphan-agent', rule: null, group: agent.rule_group,
                message: `L'agent « ${agent.name || agent.id} » référence le groupe « ${agent.rule_group} », qui n'existe pas.`,
                hint: `Créer le groupe dans le même appel, ou corriger rule_group.`,
            });
        }
    }

    // ── 6. États définis mais jamais lus ────────────────────────────────────
    const allConditionFacts = new Set();
    for (const group of [...groups, ...((context && context.ruleGroups) || [])]) {
        for (const rule of group.rules || []) {
            factsInConditions(rule.conditions, allConditionFacts);
            // Un état peut n'être lu que par un événement : value_from_fact, ou
            // value_expr.add_from_fact pour les minuteurs. Les omettre faisait
            // passer st_timeout_* pour des états morts.
            const p = (rule.event && rule.event.params) || {};
            if (p.value_from_fact) allConditionFacts.add(p.value_from_fact);
            if (p.value_expr) {
                if (p.value_expr.fact) allConditionFacts.add(p.value_expr.fact);
                if (p.value_expr.add_from_fact) allConditionFacts.add(p.value_expr.add_from_fact);
            }
        }
    }
    for (const state of (cfg && cfg.defined_states) || []) {
        if (!allConditionFacts.has(state.id)) {
            add({
                severity: 'low', code: 'write-only-state', rule: null, group: null,
                message: `L'état « ${state.id} » est défini mais aucune condition ne le lit.`,
                hint: `Soit il manque la règle qui l'exploite, soit l'état est superflu.`,
            });
        }
    }

    return warnings;
}

module.exports = { analyseConfig, factsInConditions };
