'use strict';
/*
 * Enveloppe de sécurité — ce qui sépare un simulateur d'un bâtiment réel.
 *
 * Aujourd'hui, la pire conséquence d'une règle générée de travers est un
 * mauvais chiffre dans un simulateur. Sur du matériel réel c'est un local
 * gelé, un compresseur qui bat, une nuit de chauffage à 28 °C. Les trois
 * garde-fous ci-dessous existent donc AVANT la première écriture réelle, pas
 * après le premier incident.
 *
 *   1. Traçabilité — toute commande est journalisée avec son origine. Quand un
 *      exploitant demande « pourquoi cette vanne s'est ouverte à 3 h ? », la
 *      réponse doit être lisible.
 *   2. Limitation de cadence — sur les CHANGEMENTS de valeur, pas sur les
 *      écritures. Les règles réécrivent la même consigne à chaque tick, ce qui
 *      est inoffensif ; ce qui use un actionneur, c'est l'oscillation.
 *   3. Approbation — une configuration qui commande des points réels demande un
 *      accord explicite. Inerte tant que tout est simulé.
 *
 * Comme la couche pilote, ce module est volontairement sans effet en
 * simulation : il ne doit pas transformer une démonstration en parcours
 * d'obstacles, seulement être déjà là le jour où le matériel arrive.
 */

const DEFAULT_LOG_SIZE = 500;

function ring(global, key, max) {
    let buf = global.get(key);
    if (!Array.isArray(buf)) { buf = []; global.set(key, buf); }
    if (buf.length > max) buf.splice(0, buf.length - max);
    return buf;
}

function createSafety(ctx) {
    const { global, node } = ctx;

    return {
        /**
         * Journalise une commande. `source` distingue une règle, l'assistant
         * IA, l'API ou un geste opérateur — c'est l'information qui manque
         * toujours quand on enquête après coup.
         */
        record(id, value, source, result) {
            const max = global.get('commandLogMax') || DEFAULT_LOG_SIZE;
            const buf = ring(global, 'commandLog', max);
            buf.push({
                ts: Date.now(),
                id,
                value,
                source: source || 'unknown',
                ok: result && result.ok !== false,
                error: (result && result.error) || null,
            });
            if (buf.length > max) buf.shift();
            global.set('commandLog', buf);
        },

        log(limit) {
            const buf = global.get('commandLog') || [];
            return limit ? buf.slice(-limit) : buf.slice();
        },

        /**
         * Autorise ou refuse un CHANGEMENT de valeur sur un point.
         *
         * `writeRateLimit` : { maxChangesPerMinute, points?: { id: n } }.
         * Non configuré ⇒ aucune limite : la simulation et les démonstrations
         * ne doivent pas être bridées par défaut.
         */
        allowChange(id, newValue, currentValue) {
            if (newValue === currentValue) return { allowed: true };   // réécriture idempotente

            const cfg = global.get('writeRateLimit');
            if (!cfg) return { allowed: true };

            const limit = (cfg.points && cfg.points[id] !== undefined)
                ? cfg.points[id]
                : cfg.maxChangesPerMinute;
            if (!limit || limit <= 0) return { allowed: true };

            const now = Date.now();
            const hist = global.get('changeHistory') || {};
            const recent = (hist[id] || []).filter((t) => now - t < 60000);

            if (recent.length >= limit) {
                hist[id] = recent;
                global.set('changeHistory', hist);
                return {
                    allowed: false,
                    reason: `cadence dépassée sur ${id} : ${recent.length} changements ` +
                            `dans la dernière minute (limite ${limit})`,
                };
            }

            recent.push(now);
            hist[id] = recent;
            global.set('changeHistory', hist);
            return { allowed: true };
        },

        /**
         * Points commandés par une configuration et confiés à un pilote réel.
         * Parcourt les événements des règles : control_device (un point),
         * control_group (une étiquette, donc tous les points qui la portent).
         */
        realPointsCommandedBy(cfg) {
            const io = global.get('ioDrivers');
            if (!io) return [];

            const meta = global.get('bmsMetadata') || {};
            const targets = new Set();

            for (const group of cfg.rule_groups || []) {
                for (const rule of group.rules || []) {
                    const params = (rule.event && rule.event.params) || {};
                    if (params.id) targets.add(params.id);
                    if (params.tag) {
                        for (const [pointId, m] of Object.entries(meta)) {
                            if ((m.tags || []).includes(params.tag)) targets.add(pointId);
                        }
                    }
                }
            }

            return [...targets].filter((id) => {
                const driver = io.driverFor(id);
                return driver && driver.name !== 'simulator';
            });
        },

        /**
         * Portail d'approbation. Une configuration touchant des points réels
         * doit porter `"approved": true`. Le garde-fou se désarme par
         * `requireApprovalForRealPoints = false`.
         */
        checkApproval(cfg) {
            const required = global.get('requireApprovalForRealPoints');
            if (required === false) return { approved: true, realPoints: [] };

            const realPoints = this.realPointsCommandedBy(cfg);
            if (realPoints.length === 0) return { approved: true, realPoints: [] };
            if (cfg.approved === true) {
                if (node && node.warn) {
                    node.warn(`⚠ Configuration approuvée commandant ${realPoints.length} point(s) ` +
                              `matériel(s) réel(s) : ${realPoints.join(', ')}`);
                }
                return { approved: true, realPoints };
            }

            return {
                approved: false,
                realPoints,
                message: `Cette configuration commande ${realPoints.length} point(s) pilotés par du ` +
                         `matériel réel (${realPoints.join(', ')}). Renvoyez-la avec "approved": true ` +
                         `pour confirmer, après relecture des règles concernées.`,
            };
        },
    };
}

module.exports = { createSafety };
