'use strict';
/*
 * Tests unitaires du cœur BMS — sans Node-RED.
 *
 * C'est le bénéfice concret de l'extraction : ces modules s'instancient avec un
 * faux contexte global et s'exercent en millisecondes, là où le harnais de
 * scénarios démarre un runtime complet.
 *
 *   node --test test/
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const installBms = require('../lib/bms-core/bms');
const { createRegistry, QUALITY } = require('../lib/bms-core/drivers');

/** Faux contexte global Node-RED : deux magasins, comme en production. */
function fakeContext() {
    const stores = { default: new Map(), file: new Map() };
    const messages = [];
    return {
        messages,
        global: {
            get(key, store) { return stores[store || 'default'].get(key); },
            set(key, value, store) { stores[store || 'default'].set(key, value); },
            keys(store) { return [...stores[store || 'default'].keys()]; },
        },
        node: {
            warn: (m) => messages.push({ level: 'warn', m }),
            error: (m) => messages.push({ level: 'error', m }),
            status: () => {},
        },
        env: { get: () => undefined },
    };
}

/** Un petit parc de points, suffisant pour exercer les garde-fous. */
function seedPoints(global) {
    global.set('bacnetPoints', {
        temp_zone: { objectName: 'Zone Temp', value: 21, units: '°C', access: 'read_only' },
        setpoint:  { objectName: 'Setpoint', value: 21, units: '°C', access: 'read_write', min: 15, max: 28 },
        lamp:      { objectName: 'Lamp', value: false, units: 'bool', access: 'read_write' },
    });
    global.set('virtualPoints', {
        computed: { value: 3, writable: false },
        tunable:  { value: 5, writable: true, min: 0, max: 10 },
    });
    global.set('bmsMetadata', { temp_zone: { tags: ['sensor'], zone: 'Z1' } });
}

describe('Abstraction BMS', () => {
    let ctx, BMS;

    beforeEach(() => {
        ctx = fakeContext();
        seedPoints(ctx.global);
        installBms(ctx);
        BMS = ctx.global.get('BMS');
    });

    test('getValues rassemble points matériels et virtuels', () => {
        const v = BMS.getValues();
        assert.equal(v.temp_zone, 21);
        assert.equal(v.computed, 3);
    });

    test('writeValue applique accès et bornes', () => {
        assert.equal(BMS.writeValue('temp_zone', 30), false, 'un point read_only refuse');
        assert.equal(BMS.writeValue('inconnu', 1), false, 'un point inconnu refuse');

        assert.equal(BMS.writeValue('setpoint', 99), true);
        assert.equal(BMS.getValue('setpoint'), 28, 'borné au max');

        assert.equal(BMS.writeValue('setpoint', 0), true);
        assert.equal(BMS.getValue('setpoint'), 15, 'borné au min');
    });

    test('un point virtuel non inscriptible est protégé', () => {
        assert.equal(BMS.writeValue('computed', 9), false);
        assert.equal(BMS.writeValue('tunable', 9), true);
        assert.equal(BMS.getValue('tunable'), 9);
    });

    describe('horloge système', () => {
        test('sans multiplicateur, c’est le temps réel', () => {
            const drift = Math.abs(BMS.now().getTime() - Date.now());
            assert.ok(drift < 50, `identité attendue, écart ${drift} ms`);
        });

        test('le multiplicateur accélère le temps depuis l’ancre', () => {
            const anchor = Date.now() - 1000;   // ancré il y a une seconde
            ctx.global.set('demoClock', { multiplier: 60, anchorReal: anchor, anchorVirtual: anchor });

            const elapsedVirtual = BMS.now().getTime() - anchor;
            // ~1 s réelle × 60 ≈ 60 s virtuelles.
            assert.ok(elapsedVirtual > 55000 && elapsedVirtual < 70000,
                `≈60 s virtuelles attendues, obtenu ${Math.round(elapsedVirtual / 1000)} s`);
        });
    });
});

describe('Couche pilote', () => {
    let ctx, io;

    beforeEach(() => {
        ctx = fakeContext();
        seedPoints(ctx.global);
        io = createRegistry(ctx);
        ctx.global.set('ioDrivers', io);
    });

    test('le simulateur est le pilote par défaut', () => {
        assert.deepEqual(io.list(), ['simulator']);
        assert.equal(io.driverFor('lamp').name, 'simulator');
    });

    test('l’écriture est asynchrone et rend un résultat explicite', async () => {
        const ok = await io.write('setpoint', 24);
        assert.deepEqual(ok, { ok: true, value: 24 });

        const refused = await io.write('temp_zone', 5);
        assert.equal(refused.ok, false);
        assert.match(refused.error, /read-only/);

        const missing = await io.write('nulle_part', 1);
        assert.equal(missing.ok, false);
        assert.match(missing.error, /unknown point/);
    });

    test('un point jamais écrit est de qualité inconnue', () => {
        const st = io.statusOf('lamp');
        assert.equal(st.quality, QUALITY.UNKNOWN);
        assert.equal(st.stale, false, 'inconnu n’est pas périmé');
    });

    test('une écriture horodate le point', async () => {
        await io.write('lamp', true);
        const st = io.statusOf('lamp');
        assert.equal(st.quality, QUALITY.GOOD);
        assert.equal(st.source, 'simulator');
        assert.ok(st.ageMs !== null && st.ageMs < 1000);
    });

    test('la péremption ne se déclenche que si elle est configurée', async () => {
        await io.write('lamp', true);
        assert.equal(io.statusOf('lamp').stale, false, 'sans limite, jamais périmé');

        // Limite d'une milliseconde : le point est périmé immédiatement.
        ctx.global.set('pointStaleAfter', { lamp: 1 });
        await new Promise((r) => setTimeout(r, 10));

        const st = io.statusOf('lamp');
        assert.equal(st.stale, true, 'au-delà de la limite, périmé');
        assert.equal(st.quality, QUALITY.STALE);
    });

    test('un pilote peut être associé à un point précis', async () => {
        const calls = [];
        io.register('fake-bacnet', {
            name: 'fake-bacnet',
            isHealthy: () => true,
            read: (id) => ({ value: 42, quality: QUALITY.GOOD, ts: Date.now() }),
            write: (id, value) => { calls.push([id, value]); return Promise.resolve({ ok: true, value }); },
        });
        // Un seul point bascule : le reste du bâtiment continue en simulé.
        ctx.global.set('pointDrivers', { lamp: 'fake-bacnet' });

        assert.equal(io.driverFor('lamp').name, 'fake-bacnet');
        assert.equal(io.driverFor('setpoint').name, 'simulator');

        await io.write('lamp', true);
        assert.deepEqual(calls, [['lamp', true]]);
    });
});

describe('BMS et couche pilote ensemble', () => {
    let ctx, BMS;

    beforeEach(() => {
        ctx = fakeContext();
        seedPoints(ctx.global);
        installBms(ctx);
        BMS = ctx.global.get('BMS');
    });

    test('writeValueAsync passe par le pilote', async () => {
        const res = await BMS.writeValueAsync('setpoint', 26);
        assert.equal(res.ok, true);
        assert.equal(BMS.getValue('setpoint'), 26);
        assert.equal(BMS.getStatus('setpoint').quality, QUALITY.GOOD);
    });

    test('writeValue synchrone refuse un point piloté par du matériel réel', () => {
        const io = ctx.global.get('ioDrivers');
        io.register('fake-bacnet', {
            name: 'fake-bacnet', isHealthy: () => true,
            read: () => ({ value: 1, quality: QUALITY.GOOD, ts: Date.now() }),
            write: (id, v) => Promise.resolve({ ok: true, value: v }),
        });
        ctx.global.set('pointDrivers', { lamp: 'fake-bacnet' });

        // Le refus est délibéré : une écriture réseau ne peut pas être
        // confirmée dans le tick courant, et mentir ici ferait décider les
        // règles sur une écriture qui n'a pas eu lieu.
        assert.equal(BMS.writeValue('lamp', true), false);
        assert.ok(ctx.messages.some((m) => /writeValueAsync/.test(m.m)),
            'le refus doit expliquer quoi utiliser à la place');

        // Le reste du bâtiment n'est pas affecté.
        assert.equal(BMS.writeValue('setpoint', 22), true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Enveloppe de sécurité', () => {
    const { createSafety } = require('../lib/bms-core/safety');
    let ctx, safety;

    beforeEach(() => {
        ctx = fakeContext();
        seedPoints(ctx.global);
        installBms(ctx);
        safety = ctx.global.get('bmsSafety');
    });

    test('les réécritures identiques ne sont pas comptées comme des changements', () => {
        ctx.global.set('writeRateLimit', { maxChangesPerMinute: 2 });
        // Une règle qui réaffirme la même consigne à chaque tick est inoffensive
        // et ne doit jamais épuiser le quota.
        for (let i = 0; i < 50; i++) {
            assert.equal(safety.allowChange('setpoint', 21, 21).allowed, true);
        }
    });

    test('la cadence de changement est limitée quand elle est configurée', () => {
        ctx.global.set('writeRateLimit', { maxChangesPerMinute: 3 });
        let current = 0;
        const results = [];
        for (let i = 1; i <= 5; i++) {
            const r = safety.allowChange('lamp', i, current);
            results.push(r.allowed);
            if (r.allowed) current = i;
        }
        assert.deepEqual(results, [true, true, true, false, false], 'les 3 premiers passent');
    });

    test('sans configuration, aucune limite', () => {
        for (let i = 0; i < 100; i++) {
            assert.equal(safety.allowChange('lamp', i, i - 1).allowed, true);
        }
    });

    test('le journal retient origine et résultat', () => {
        const BMS = ctx.global.get('BMS');
        BMS.writeValue('setpoint', 24);
        BMS.writeValue('setpoint', 24);   // idempotent : non journalisé
        BMS.writeValue('setpoint', 25);

        const log = safety.log();
        assert.equal(log.length, 2, 'seuls les changements sont tracés');
        assert.deepEqual(log.map((e) => e.value), [24, 25]);
        assert.ok(log.every((e) => e.ok === true));
    });

    describe('portail d’approbation', () => {
        const configTouching = (pointId) => ({
            rule_groups: [{
                id: 'rg', name: 'g', rules: [{
                    name: 'r', conditions: { all: [] },
                    event: { type: 'control_device', params: { id: pointId, value: 1 } },
                }],
            }],
        });

        test('tout simulé : aucune approbation requise', () => {
            const verdict = safety.checkApproval(configTouching('setpoint'));
            assert.equal(verdict.approved, true);
            assert.deepEqual(verdict.realPoints, []);
        });

        test('un point réel bloque une configuration non approuvée', () => {
            const io = ctx.global.get('ioDrivers');
            io.register('fake-bacnet', {
                name: 'fake-bacnet', isHealthy: () => true,
                read: () => ({ value: 1 }), write: (i, v) => Promise.resolve({ ok: true, value: v }),
            });
            ctx.global.set('pointDrivers', { setpoint: 'fake-bacnet' });

            const blocked = safety.checkApproval(configTouching('setpoint'));
            assert.equal(blocked.approved, false);
            assert.deepEqual(blocked.realPoints, ['setpoint']);
            assert.match(blocked.message, /approved/);

            const cfg = configTouching('setpoint');
            cfg.approved = true;
            assert.equal(safety.checkApproval(cfg).approved, true);
        });

        test('applyConfig refuse et explique', () => {
            const io = ctx.global.get('ioDrivers');
            io.register('fake-bacnet', {
                name: 'fake-bacnet', isHealthy: () => true,
                read: () => ({ value: 1 }), write: (i, v) => Promise.resolve({ ok: true, value: v }),
            });
            ctx.global.set('pointDrivers', { lamp: 'fake-bacnet' });

            const BMS = ctx.global.get('BMS');
            const res = BMS.applyConfig(configTouching('lamp'));
            assert.equal(res.applied.length, 0, 'rien ne doit être appliqué');
            assert.deepEqual(res.pendingApproval.realPoints, ['lamp']);
        });

        test('une règle par étiquette est résolue vers ses points', () => {
            const io = ctx.global.get('ioDrivers');
            io.register('fake-bacnet', {
                name: 'fake-bacnet', isHealthy: () => true,
                read: () => ({ value: 1 }), write: (i, v) => Promise.resolve({ ok: true, value: v }),
            });
            ctx.global.set('pointDrivers', { temp_zone: 'fake-bacnet' });

            const verdict = safety.checkApproval({
                rule_groups: [{
                    id: 'rg', name: 'g', rules: [{
                        name: 'r', conditions: { all: [] },
                        event: { type: 'control_group', params: { tag: 'sensor', value: 1 } },
                    }],
                }],
            });
            assert.deepEqual(verdict.realPoints, ['temp_zone'],
                'control_group doit être développé via les étiquettes');
        });
    });
});
