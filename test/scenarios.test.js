'use strict';
/*
 * Scénarios de référence — le filet de sécurité du système.
 *
 * Ils décrivent le comportement observable du BMS par son API : inventaire,
 * éclairage sur présence, paliers de ventilation CO2 avec hystérésis, consignes
 * de température, garde-fous de la couche BMS, application et suppression de
 * configuration. Toute refonte interne (extraction du cœur, couche pilote,
 * écritures asynchrones) doit les laisser verts.
 *
 *   node --test test/
 *
 * Chaque exécution démarre une instance jetable : ni ~/.node-red ni la
 * configuration en cours ne sont touchés.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, sleep } = require('./lib/harness');

let bms;      // client
let instance;

before(async () => {
    instance = await startInstance({ seed: true });
    bms = instance.client;
}, { timeout: 120000 });

after(async () => {
    if (instance) await instance.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Inventaire', () => {
    test('le bâtiment simulé expose le parc attendu', async () => {
        const ctx = await bms.context();
        const hw = Object.keys(ctx.points.sensors).length
                 + Object.keys(ctx.points.actuators).length
                 + Object.keys(ctx.points.weather).length;

        assert.equal(Object.keys(ctx.points.sensors).length, 51, 'capteurs');
        assert.equal(Object.keys(ctx.points.actuators).length, 33, 'actionneurs');
        assert.equal(Object.keys(ctx.points.weather).length, 2, 'points météo');
        assert.equal(hw, 86, 'total points matériels');
        assert.equal(Object.keys(ctx.virtualPoints).length, 18, 'points virtuels');
    });

    test('la configuration de démonstration est chargée et le moteur tourne', async () => {
        const fl = await bms.firelog();
        assert.equal(fl.rulesLoaded, 130, 'règles chargées');
        assert.equal(fl.agents.length, 7, 'agents');
        assert.equal(fl.physics_enabled, true, 'physique active');

        const ctx = await bms.context();
        assert.equal(ctx.config.behavior_agents.length, 7);
        assert.equal(ctx.config.rule_groups.length, 7);
        assert.equal(ctx.config.defined_states.length, 37);
    });

    test('les états internes sont exposés comme faits', async () => {
        const pts = await bms.points();
        const states = Object.keys(pts).filter((k) => k.startsWith('st_'));
        assert.equal(states.length, 37, 'états exposés');
        assert.ok('st_timeout_office' in pts, 'st_timeout_office présent');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Éclairage sur présence', () => {
    test('une détection allume la lampe et lève l’état d’occupation', async () => {
        await bms.sensor('f2_off1_motion', false);
        await sleep(1500);

        await bms.sensor('f2_off1_motion', true);

        await bms.expectPoint('st_off_f2_1_occupied', true, { label: 'état occupé' });
        await bms.expectPoint('f2_off1_lamp', true, { label: 'lampe' });
    });

    test('la temporisation d’inoccupation retient l’extinction', async () => {
        // La lampe ne doit PAS s'éteindre dès la disparition de la présence :
        // st_timeout_office (15 min) doit d'abord expirer.
        await bms.sensor('f2_off1_motion', false);
        await sleep(4000);

        const pts = await bms.points();
        assert.equal(pts.f2_off1_lamp, true, 'la lampe reste allumée pendant la temporisation');
        assert.equal(pts.st_off_f2_1_occupied, true, 'la zone reste occupée pendant la temporisation');

        const timer = pts.st_off_f2_1_occ_timer;
        const now = pts.glob_time_epoch_min;
        assert.ok(timer > now, `l'échéance ${timer} doit être postérieure à l'instant ${now}`);
        assert.ok(timer - now <= pts.st_timeout_office,
            'la temporisation restante ne dépasse pas st_timeout_office');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Ventilation — paliers CO2 et hystérésis', () => {
    // Seuils montants 800 / 1200 ppm, descendants 1000 / 650 ppm.
    // L'écart entre les deux est l'hystérésis : sans elle, le palier battrait.

    test('la montée du CO2 fait gravir les paliers', async () => {
        await bms.sensor('f2_off1_co2', 420);
        await bms.expectPoint('st_off_f2_1_co2_stage', 0, { label: 'palier initial' });
        await bms.expectPoint('f2_off1_vent', 10, { label: 'ventilation palier 0' });

        await bms.sensor('f2_off1_co2', 950);
        await bms.expectPoint('st_off_f2_1_co2_stage', 1, { label: 'palier après 800 ppm' });
        await bms.expectPoint('f2_off1_vent', 40, { label: 'ventilation palier 1' });

        await bms.sensor('f2_off1_co2', 1350);
        await bms.expectPoint('st_off_f2_1_co2_stage', 2, { label: 'palier après 1200 ppm' });
        await bms.expectPoint('f2_off1_vent', 80, { label: 'ventilation palier 2' });
    });

    test('la descente respecte l’hystérésis', async () => {
        // 1100 ppm est sous le seuil montant (1200) mais au-dessus du seuil
        // descendant (1000) : le palier 2 doit tenir.
        await bms.sensor('f2_off1_co2', 1100);
        await sleep(4000);
        let pts = await bms.points();
        assert.equal(pts.st_off_f2_1_co2_stage, 2,
            'à 1100 ppm le palier 2 tient — sinon l’hystérésis est perdue');

        await bms.sensor('f2_off1_co2', 900);
        await bms.expectPoint('st_off_f2_1_co2_stage', 1, { label: 'palier après passage sous 1000' });
        await bms.expectPoint('f2_off1_vent', 40, { label: 'ventilation redescendue' });

        // Idem entre les deux seuils bas : 700 ppm ne doit pas ramener au palier 0.
        await bms.sensor('f2_off1_co2', 700);
        await sleep(4000);
        pts = await bms.points();
        assert.equal(pts.st_off_f2_1_co2_stage, 1, 'à 700 ppm le palier 1 tient');

        await bms.sensor('f2_off1_co2', 500);
        await bms.expectPoint('st_off_f2_1_co2_stage', 0, { label: 'retour au palier 0' });
        await bms.expectPoint('f2_off1_vent', 10, { label: 'ventilation au repos' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Consignes de température', () => {
    test('la consigne suit le régime horaire du bâtiment', async () => {
        // Les règles « Business Hours → All Comfort » et « Outside Hours → All
        // Eco » pilotent toutes les consignes par étiquette. On lit l'heure du
        // système plutôt que de la supposer : le test reste vrai à toute heure.
        const pts = await bms.points();
        const hour = pts.glob_time_hour;
        const businessHours = hour >= 7 && hour < 19;
        const expected = businessHours ? pts.glob_comfort_sp : pts.glob_eco_sp;

        await bms.expectPoint('f3_off3_temp_setpoint', expected, {
            label: `consigne à ${hour} h (${businessHours ? 'heures ouvrées' : 'hors heures'})`,
            timeout: 20000,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Physique — convergence', () => {
    test('la simulation tourne réellement', async () => {
        // Garde-fou : le test de stabilité ci-dessous passerait aussi bien si la
        // physique était morte. Il faut d'abord prouver qu'elle vit — c'est ce
        // qui a manqué quand l'extraction du moteur l'a silencieusement coupée.
        await bms.sensor('f3_off3_temp', 30);   // loin de la consigne
        const moved = await bms.expectPointWhere('f3_off3_temp', (v) => v < 29.8, {
            timeout: 20000, describe: 'la température doit redescendre vers la consigne',
        });
        assert.ok(moved < 30, `la physique doit corriger l’écart, obtenu ${moved}`);
    });

    test('la température se stabilise au lieu de battre autour de la consigne', async () => {
        // La bande morte (0.15 °C) doit dépasser le pas d'arrondi (0.1 °C),
        // sinon la boucle recalcule sans fin et laisse un décalage résiduel.
        // D'abord attendre la convergence : mesurer la stabilité d'une zone
        // encore en train de rejoindre sa consigne ne teste rien. La consigne
        // elle-même peut bouger (régime horaire), donc on la relit à chaque
        // tour plutôt que de la figer.
        const deadline = Date.now() + 90000;
        let temp, setpoint;
        while (Date.now() < deadline) {
            const p = await bms.points();
            temp = p.f3_off2_temp; setpoint = p.f3_off2_temp_setpoint;
            if (Math.abs(temp - setpoint) <= 0.3) break;
            await sleep(1000);
        }
        assert.ok(Math.abs(temp - setpoint) <= 0.3,
            `la zone doit rejoindre sa consigne ${setpoint}, obtenu ${temp}`);

        // Une fois convergée, la bande morte (0.15 °C) doit la tenir tranquille.
        const first = (await bms.points()).f3_off2_temp;
        await sleep(6000);
        const second = (await bms.points()).f3_off2_temp;
        assert.ok(Math.abs(second - first) <= 0.2,
            `la température doit être stable une fois convergée : ${first} puis ${second}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Garde-fous de la couche BMS', () => {
    test('un capteur en lecture seule refuse l’écriture', async () => {
        const r = await bms.write('f1_lobby_motion', true);
        assert.equal(r.status, 403, 'écriture sur capteur read_only');
        assert.match(r.body.error, /read-only|refus/i);
    });

    test('un état interne n’est pas écrivable par l’API', async () => {
        const r = await bms.write('st_timeout_office', 1);
        assert.equal(r.status, 403, 'seules les règles écrivent les états');
    });

    test('les bornes min/max sont appliquées', async () => {
        // f1_lobby_temp_setpoint : min 15, max 28.
        const high = await bms.write('f1_lobby_temp_setpoint', 99);
        assert.equal(high.status, 200);
        assert.equal(high.body.value, 28, 'valeur haute ramenée au max');

        const low = await bms.write('f1_lobby_temp_setpoint', -5);
        assert.equal(low.status, 200);
        assert.equal(low.body.value, 15, 'valeur basse ramenée au min');
    });

    test('un point inconnu est rejeté', async () => {
        const r = await bms.write('point_qui_nexiste_pas', 1);
        assert.equal(r.status, 403);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Application de configuration', () => {
    const AGENT = 'agent_test_harness';
    const GROUP = 'rg_test_harness';
    const STATE = 'st_test_harness';

    const config = {
        merge: true,
        behavior_agents: [{
            id: AGENT, name: 'Harnais de test', description: 'Agent créé par les tests.',
            category: 'energy', enabled: true, rule_group: GROUP,
        }],
        defined_states: [{
            id: STATE, name: 'Témoin de test', type: 'boolean',
            defaultValue: false, ttl: 600, description: 'Témoin levé par les tests.',
        }],
        rule_groups: [{
            id: GROUP, name: 'Harnais de test', rules: [{
                name: 'Réservation sans présence → témoin',
                priority: 10,
                conditions: { all: [
                    { fact: 'f1_meet_booking', operator: 'equal', value: true },
                    { fact: 'f1_meet_motion', operator: 'equal', value: false },
                ] },
                event: { type: 'set_state', params: { id: STATE, value: true } },
            }],
        }],
    };

    test('merge ajoute sans écraser la configuration existante', async () => {
        const res = await bms.applyConfig(config);

        assert.deepEqual(res.unknownFacts, [], 'aucun fait inconnu');
        assert.deepEqual(res.errors, [], 'aucune erreur');
        assert.equal(res.counts.agents, 8, 'les 7 agents d’origine sont conservés');
        assert.equal(res.counts.groups, 8);
        assert.equal(res.counts.rules, 131);
        assert.equal(res.counts.states, 38);
    });

    test('la règle appliquée se charge et déclenche réellement', async () => {
        const since = Date.now();
        await bms.sensor('f1_meet_motion', false);
        await bms.write('f1_meet_booking', true);

        await bms.expectPoint(STATE, true, { label: 'témoin levé par la règle' });
        await bms.expectRuleFired('Réservation sans présence', { since });

        const fl = await bms.firelog();
        const group = fl.groups.find((g) => g.id === GROUP);
        assert.ok(group, 'le groupe apparaît dans le firelog');
        assert.ok(group.rules.includes('Réservation sans présence → témoin'));
    });

    test('un fait inexistant est signalé sans casser le moteur', async () => {
        const res = await bms.applyConfig({
            merge: true,
            rule_groups: [{
                id: 'rg_test_fait_inconnu', name: 'Fait inconnu', rules: [{
                    name: 'Règle morte',
                    conditions: { all: [{ fact: 'f9_inexistant_temp', operator: 'equal', value: 1 }] },
                    event: { type: 'set_state', params: { id: STATE, value: false } },
                }],
            }],
        });

        assert.ok(res.unknownFacts.includes('f9_inexistant_temp'),
            'le fait inconnu doit être signalé — sinon la règle est morte en silence');

        // Le moteur doit survivre : les règles saines continuent de tourner.
        const fl = await bms.firelog();
        assert.ok(fl.rulesLoaded >= 131, 'les règles existantes restent chargées');

        await bms.applyConfig({ merge: true, rule_groups: [{ id: 'rg_test_fait_inconnu', remove: true }] });
    });

    test('les suppressions retirent bien agent, groupe et état', async () => {
        const res = await bms.applyConfig({
            merge: true,
            remove_agents: [AGENT],
            remove_states: [STATE],
            rule_groups: [{ id: GROUP, remove: true }],
        });
        assert.deepEqual(res.errors ?? [], []);

        const ctx = await bms.context();
        assert.equal(ctx.config.behavior_agents.length, 7, 'retour aux 7 agents');
        assert.equal(ctx.config.rule_groups.length, 7);
        assert.equal(ctx.config.defined_states.length, 37);
        assert.ok(!ctx.config.behavior_agents.some((a) => a.id === AGENT));
        assert.ok(!ctx.config.rule_groups.some((g) => g.id === GROUP));

        await bms.write('f1_meet_booking', false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Placé en dernier : ce bloc manipule l'horloge du système et contaminerait les
// scénarios précédents. Il rétablit 1× en sortant.
// ─────────────────────────────────────────────────────────────────────────────

describe('Mode Démo / Test — vitesse du temps', () => {
    const demomode = async (multiplier) => {
        const res = await fetch(`${bms.base}/bms/demomode`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ multiplier }),
        });
        return { status: res.status, body: await res.json() };
    };
    const readMode = async () => (await fetch(`${bms.base}/bms/demomode`)).json();

    test('par défaut le multiplicateur vaut 1 et l’horloge est le temps réel', async () => {
        const state = await readMode();
        assert.equal(state.multiplier, 1, 'défaut 1× — aucune accélération sans action explicite');
        assert.equal(state.accelerated, false);

        const drift = Math.abs(new Date(state.virtualTime) - new Date(state.realTime));
        assert.ok(drift < 2000, `à 1× l'horloge système doit être l'horloge réelle (écart ${drift} ms)`);
    });

    test('un multiplicateur non prévu est refusé', async () => {
        const bad = await demomode(7);
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /multiplier must be one of/);

        const state = await readMode();
        assert.equal(state.multiplier, 1, 'un refus ne doit rien changer');
    });

    test('l’accélération fait courir les faits temporels plus vite', async () => {
        const applied = await demomode(60);
        assert.equal(applied.status, 200);
        assert.equal(applied.body.multiplier, 60);
        assert.equal(applied.body.accelerated, true);

        // st_timeout_office (15 min) doit désormais s'écouler en ~15 s réelles.
        assert.equal(applied.body.occupancyTimeoutRealSeconds, 15);

        const before = (await bms.points()).glob_time_epoch_min;
        await sleep(6000);
        const after = (await bms.points()).glob_time_epoch_min;

        // 6 s réelles à 60× ≈ 6 minutes système. On tolère largement le tick.
        const elapsed = after - before;
        assert.ok(elapsed >= 4, `le compteur système doit avancer vite : +${elapsed} min en 6 s`);
    });

    test('la temporisation d’inoccupation finit par expirer', async () => {
        // Ce chemin est intestable à 1× : il demanderait 15 minutes d'attente.
        // C'est précisément ce que le mode Démo/Test débloque.
        await bms.sensor('f3_off1_motion', true);
        await bms.expectPoint('f3_off1_lamp', true, { label: 'lampe allumée par la présence' });

        await bms.sensor('f3_off1_motion', false);
        await bms.expectPoint('st_off_f3_1_occupied', false, {
            timeout: 45000, label: 'occupation retombée après expiration',
        });
        await bms.expectPoint('f3_off1_lamp', false, {
            timeout: 20000, label: 'lampe éteinte après expiration',
        });
    });

    test('le retour à 1× rétablit le temps réel', async () => {
        const back = await demomode(1);
        assert.equal(back.status, 200);
        assert.equal(back.body.multiplier, 1);
        assert.equal(back.body.accelerated, false);

        const state = await readMode();
        const drift = Math.abs(new Date(state.virtualTime) - new Date(state.realTime));
        assert.ok(drift < 2000, `retour au temps réel attendu (écart ${drift} ms)`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Profils COV', () => {
    /** Remet le sujet à zéro : le socle seul, aucune surcharge. */
    async function reset() {
        const s = await bms.covState();
        for (const name of Object.keys(s.profiles)) {
            if (name !== s.defaultProfileName) await bms.cov({ action: 'deleteProfile', name });
        }
        await bms.cov({ action: 'setAssignments', assignments: [] });
        for (const id of Object.keys(s.overrides)) {
            await bms.cov({ action: 'setOverride', pointId: id, profile: null });
        }
    }

    test('l’état expose l’incrément effectif et sa provenance pour les 86 points', async () => {
        await reset();
        const s = await bms.covState();

        assert.equal(Object.keys(s.points).length, 86);
        assert.equal(s.connected, true, 'le harnais tourne sur le serveur BACnet de test');

        const temp = s.points.f1_lobby_temp;
        assert.equal(temp.unit, '°C');
        assert.equal(temp.increment, s.unitDefaults['°C']);
        assert.equal(temp.source, 'default');
        // L'incrément est réellement posé dans l'appareil, pas seulement décidé.
        assert.equal(temp.applied, temp.increment,
            'le pilote doit avoir écrit COV_Increment sur l’objet distant');

        const motion = s.points.f1_lobby_motion;
        assert.equal(motion.unit, 'bool');
        assert.equal(motion.applied, null, 'un binaire n’a pas de COV_Increment');

        assert.ok(typeof temp.notifPerMin === 'number',
            'la colonne notif/min doit être alimentée quand un serveur est connecté');
    });

    test('l’API publie ce que l’appareil sait faire — l’interface s’y conforme', async () => {
        const s = await bms.covState();
        assert.ok(s.capabilities, 'sans capacités, l’interface ne peut pas décider quoi afficher');
        assert.equal(s.capabilities.subscribeCovProperty, true,
            'le serveur de test annonce SubscribeCOVProperty');
        assert.equal(s.capabilities.covIncrementSettable, true,
            'donc les réglages d’incrément doivent être proposés : ' + s.capabilities.reason);
        assert.ok(typeof s.capabilities.reason === 'string' && s.capabilities.reason.length > 0,
            'la raison est affichée à l’utilisateur quand le réglage est masqué');
    });

    test('un profil creux appliqué à tout le parc ne touche que ses unités', async () => {
        await reset();
        const created = await bms.cov({
            action: 'setProfile',
            profile: { name: 'CO2 fin', increments: { ppm: 10 } },
        });
        assert.equal(created.status, 200);

        const ids = Object.keys((await bms.covState()).points);
        const p = await bms.cov({ action: 'preview', profile: 'CO2 fin', pointIds: ids });
        assert.equal(p.status, 200);
        // 13 zones, mais seules celles qui portent un capteur CO2 en ont un.
        assert.equal(p.body.preview.matchingCount, 8,
            'seuls les 8 points en ppm sont concernés — c’est ce que la confirmation doit annoncer');
        assert.equal(p.body.preview.notMatchingCount, 78);
        assert.equal(p.body.preview.manualCount, 0);

        const applied = await bms.cov({
            action: 'applyToPoints', profile: 'CO2 fin', pointIds: ids,
        });
        assert.equal(applied.body.applied.appliedCount, 8);
        assert.equal(applied.body.applied.skippedNoUnit, 78);

        const after = await bms.covState();
        assert.equal(after.points.f1_lobby_co2.increment, 10);
        assert.equal(after.points.f1_lobby_co2.source, 'manual');
        assert.equal(after.points.f1_lobby_temp.increment, after.unitDefaults['°C'],
            'un point d’une autre unité doit rester au socle');
    });

    test('l’incrément modifié atteint réellement l’appareil', async () => {
        await reset();
        await bms.cov({ action: 'setProfile', profile: { name: 'grossier', increments: { '°C': 1.5 } } });
        const r = await bms.cov({ action: 'setOverride', pointId: 'f1_meet_temp', profile: 'grossier' });

        assert.equal(r.status, 200);
        assert.ok(r.body.pushed && r.body.pushed.written >= 1,
            'toute édition doit repousser les incréments : ' + JSON.stringify(r.body.pushed));

        const s = await bms.covState();
        assert.equal(s.points.f1_meet_temp.increment, 1.5);
        assert.equal(s.points.f1_meet_temp.applied, 1.5,
            'sinon la bande morte reste celle de l’appareil, et le réglage est décoratif');
    });

    test('l’affectation par étiquette suit les points sans intervention', async () => {
        await reset();
        await bms.cov({ action: 'setProfile', profile: { name: 'CO2 fin', increments: { ppm: 7 } } });
        const a = await bms.cov({
            action: 'setAssignments', assignments: [{ tag: 'meeting', profile: 'CO2 fin' }],
        });
        assert.equal(a.status, 200);

        const s = await bms.covState();
        assert.equal(s.points.f1_meet_co2.increment, 7);
        assert.equal(s.points.f1_meet_co2.source, 'tag:meeting');
        assert.equal(s.points.f1_lobby_co2.source, 'default', 'les autres zones ne bougent pas');
        // Le point porte l'étiquette mais son unité n'est pas dans le profil.
        assert.equal(s.points.f1_meet_temp.source, 'default');
    });

    test('l’application en masse préserve les surcharges sauf case cochée', async () => {
        await reset();
        await bms.cov({ action: 'setProfile', profile: { name: 'A', increments: { ppm: 5 } } });
        await bms.cov({ action: 'setProfile', profile: { name: 'B', increments: { ppm: 50 } } });
        await bms.cov({ action: 'setOverride', pointId: 'f1_lobby_co2', profile: 'A' });

        const ids = Object.keys((await bms.covState()).points);
        const kept = await bms.cov({ action: 'applyToPoints', profile: 'B', pointIds: ids });
        assert.equal(kept.body.applied.skippedManual, 1);
        assert.equal((await bms.covState()).points.f1_lobby_co2.increment, 5, 'non écrasé');

        const forced = await bms.cov({
            action: 'applyToPoints', profile: 'B', pointIds: ids, overwriteManual: true,
        });
        assert.equal(forced.body.applied.overwrittenManual, 1);
        assert.equal((await bms.covState()).points.f1_lobby_co2.increment, 50);
    });

    test('les refus sont explicites', async () => {
        const unknown = await bms.cov({ action: 'setOverride', pointId: 'point_inexistant', profile: 'default' });
        assert.equal(unknown.status, 400);
        assert.match(unknown.body.error, /point inconnu/);

        const reserved = await bms.cov({ action: 'setProfile', profile: { name: 'default', increments: {} } });
        assert.equal(reserved.status, 200, 'éditer le socle est permis');

        const gone = await bms.cov({ action: 'deleteProfile', name: 'default' });
        assert.equal(gone.status, 400);
        assert.match(gone.body.error, /socle/);

        const nonsense = await bms.cov({ action: 'faire_le_café' });
        assert.equal(nonsense.status, 400);
        assert.match(nonsense.body.error, /action attendue/);
    });

    test('les règles continuent de voir bouger le bâtiment', async () => {
        // Une bande morte ne doit pas couper le lien : le socle reste assez fin
        // pour que la boucle présence → éclairage réagisse comme avant.
        await reset();
        await bms.sensor('f2_off2_motion', true);
        await bms.expectPoint('f2_off2_lamp', true, {
            timeout: 25000, label: 'lampe allumée malgré les bandes mortes',
        });
        await bms.sensor('f2_off2_motion', false);
    });
});
