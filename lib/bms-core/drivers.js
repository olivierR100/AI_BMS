'use strict';
/*
 * Couche pilote (IO) — la couture matérielle.
 *
 * Aujourd'hui un seul pilote existe : le simulateur, qui lit et écrit la table
 * `bacnetPoints` en mémoire. Demain un pilote BACnet lira et écrira de vrais
 * contrôleurs. Rien au-dessus de `BMS` ne doit changer le jour où l'on bascule.
 *
 * Trois différences irréductibles entre simulé et réel, prises en compte ici
 * dès maintenant plutôt qu'après coup :
 *
 *   1. Une écriture réelle est ASYNCHRONE et peut échouer (timeout, refus,
 *      contrôleur absent). D'où `write()` qui rend une promesse.
 *   2. Une valeur réelle a un ÂGE et une QUALITÉ. Un contrôleur injoignable ne
 *      renvoie pas une erreur : il ne renvoie rien, et la dernière valeur
 *      connue reste en mémoire. Sans horodatage, les règles continuent de
 *      décider sur des données mortes en toute confiance.
 *   3. Une écriture réelle porte une PRIORITÉ (tableau de priorités BACnet).
 *
 * Le pilote simulateur satisfait ce contrat de façon triviale : ses écritures
 * réussissent toujours et ses valeurs ne sont jamais périmées. Le mécanisme est
 * donc inerte tant qu'on simule — c'est voulu.
 */

const QUALITY = {
    GOOD: 'good',            // valeur fraîche et fiable
    STALE: 'stale',          // trop ancienne pour être crue
    UNRELIABLE: 'unreliable',// le pilote signale un problème
    UNKNOWN: 'unknown',      // jamais lue
};

/**
 * Journal d'état par point : { ts, quality, source }.
 * Vit dans le contexte global (magasin mémoire) — volumineux, non sérialisable
 * utilement, et reconstruit à chaud à chaque écriture.
 */
function statusTable(global) {
    let t = global.get('pointStatus');
    if (!t) { t = {}; global.set('pointStatus', t); }
    return t;
}

function markWritten(global, id, source, quality) {
    const t = statusTable(global);
    t[id] = { ts: Date.now(), quality: quality || QUALITY.GOOD, source: source || 'simulator' };
    global.set('pointStatus', t);
}

/**
 * Pilote simulateur : la table bacnetPoints EST le matériel.
 */
function createSimulatorDriver({ global }) {
    return {
        name: 'simulator',

        /** Le simulateur est toujours joignable. */
        isHealthy() { return true; },

        read(id) {
            const bp = global.get('bacnetPoints') || {};
            const p = bp[id];
            if (!p) return { value: undefined, quality: QUALITY.UNKNOWN, ts: null };
            const st = statusTable(global)[id];
            return { value: p.value, quality: QUALITY.GOOD, ts: st ? st.ts : null };
        },

        /**
         * Écriture synchrone sous le capot, exposée en promesse pour que les
         * appelants soient déjà écrits comme il faudra qu'ils le soient.
         * `priority` est accepté et ignoré : le simulateur n'a pas de tableau
         * de priorités, un contrôleur BACnet en aura un.
         */
        write(id, value /* , { priority } = {} */) {
            const bp = global.get('bacnetPoints') || {};
            const p = bp[id];
            if (!p) {
                return Promise.resolve({ ok: false, error: 'unknown point: ' + id });
            }
            if (p.access !== 'read_write') {
                return Promise.resolve({ ok: false, error: 'read-only point: ' + id });
            }
            let v = value;
            if (p.min !== undefined && v < p.min) v = p.min;
            if (p.max !== undefined && v > p.max) v = p.max;
            p.value = v;
            global.set('bacnetPoints', bp);
            markWritten(global, id, 'simulator', QUALITY.GOOD);
            return Promise.resolve({ ok: true, value: v });
        },
    };
}

/**
 * Sélection du pilote par point. `pointDrivers` associe un id de point à un nom
 * de pilote ; tout point non listé retombe sur le pilote par défaut.
 *
 * C'est ce qui permettra de piloter UN vrai contrôleur au milieu de 85 points
 * simulés, plutôt que de basculer tout le bâtiment d'un coup.
 */
function createRegistry(ctx) {
    const { global } = ctx;
    const drivers = { simulator: createSimulatorDriver(ctx) };

    return {
        QUALITY,

        register(name, driver) { drivers[name] = driver; },
        driverOrNull(name) { return drivers[name] || null; },
        list() { return Object.keys(drivers); },

        driverFor(id) {
            const map = global.get('pointDrivers') || {};
            const name = map[id] || global.get('defaultDriver') || 'simulator';
            return drivers[name] || drivers.simulator;
        },

        read(id) { return this.driverFor(id).read(id); },

        write(id, value, opts) { return this.driverFor(id).write(id, value, opts); },

        /**
         * Âge et qualité d'un point. `staleAfterMs` vient de `pointStaleAfter`
         * (par point) ou de `defaultStaleAfterMs`. Sans configuration, rien
         * n'est jamais périmé : le simulateur ne doit pas déclencher de fausses
         * alertes de fraîcheur.
         */
        statusOf(id) {
            const st = statusTable(global)[id];
            if (!st) return { quality: QUALITY.UNKNOWN, ts: null, ageMs: null, stale: false, source: null };

            const perPoint = global.get('pointStaleAfter') || {};
            const limit = perPoint[id] !== undefined ? perPoint[id] : global.get('defaultStaleAfterMs');
            const ageMs = Date.now() - st.ts;
            const stale = (typeof limit === 'number' && limit > 0) ? ageMs > limit : false;

            return {
                quality: stale ? QUALITY.STALE : st.quality,
                ts: st.ts, ageMs, stale, source: st.source,
            };
        },

        markWritten(id, source, quality) { markWritten(global, id, source, quality); },
    };
}

module.exports = { createRegistry, createSimulatorDriver, QUALITY };
