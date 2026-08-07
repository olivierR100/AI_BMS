'use strict';
/*
 * Tests BACnet — pilote client contre le serveur de test, sur le réseau.
 *
 * Ces tests parlent vraiment BACnet/IP en UDP sur la boucle locale : encodage,
 * parcours, souscriptions COV, écritures avec priorité. C'est le seul moyen de
 * vérifier le chemin qui remplacera le simulateur en mémoire.
 *
 *   node --test test/bacnet.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const bacnetClient = require('@bacnet-js/client');
const { createBacnetDriver } = require('../lib/bms-core/drivers/bacnet');
const { subscribeCovProperty } = require('../lib/bms-core/drivers/cov-property');
const installPoints = require('../lib/bms-core/points');
const installCov = require('../lib/bms-core/cov');

const REPO = path.resolve(__dirname, '..');
const SERVER_PORT = 47820;
const CLIENT_PORT = 47821;
const CONTROL_PORT = 47822;   // distinct du simulateur de développement (47811)
const PROBE_PORT = 47823;     // second superviseur, pour prouver l'indépendance des abonnements
const DEVICE_ID = 4321;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Contexte global Node-RED simulé, avec les vraies tables de points. */
function fakeContext() {
    const stores = { default: new Map(), file: new Map() };
    const messages = [];
    const ctx = {
        messages,
        global: {
            get: (k, s) => stores[s || 'default'].get(k),
            set: (k, v, s) => stores[s || 'default'].set(k, v),
        },
        node: { warn: (m) => messages.push(m), error: (m) => messages.push(m), status() {} },
        env: { get: () => undefined },
    };
    installPoints(ctx);
    // Les profils COV font partie du contexte que le pilote lit à la connexion :
    // sans eux, aucun incrément ne serait poussé dans l'appareil.
    ctx.cov = installCov(ctx);
    return ctx;
}

/** Attend qu'une condition devienne vraie, ou échoue avec un message utile. */
async function eventually(fn, { timeout = 15000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await sleep(300);
    }
    throw new Error(`${label} non satisfaite après ${timeout} ms (dernier: ${JSON.stringify(last)})`);
}

let server, ctx, driver;

before(async () => {
    server = spawn('node', [
        path.join(REPO, 'lib/bacnet-sim/server.js'),
        '--port', String(SERVER_PORT), '--device-id', String(DEVICE_ID),
        '--control-port', String(CONTROL_PORT),
        '--interface', '127.0.0.1', '--tick', '1500', '--quiet',
    ], { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });

    const errors = [];
    server.stderr.on('data', (d) => errors.push(String(d)));
    server.on('exit', (code) => { if (code) errors.push('serveur arrêté code ' + code); });

    await sleep(2500);
    if (server.exitCode !== null) throw new Error('le serveur BACnet n’a pas démarré : ' + errors.join(''));

    ctx = fakeContext();
    driver = createBacnetDriver(ctx, {
        host: '127.0.0.1', port: SERVER_PORT, clientPort: CLIENT_PORT,
        deviceId: DEVICE_ID, interface: '127.0.0.1',
        broadcastAddress: '127.255.255.255',
        refreshMs: 5000, covLifetime: 300,
    });
}, { timeout: 60000 });

after(async () => {
    if (driver) driver.disconnect();
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await sleep(500);
});

describe('Serveur BACnet de test', () => {
    test('le parcours retrouve les 86 points, nommés par identifiant de fait', async () => {
        const result = await driver.connect();

        assert.equal(result.connected, true);
        assert.equal(result.objects, 86, 'le device expose les 86 points du bâtiment');
        assert.equal(result.bound, 86, 'tous les points se lient par object-name');
        assert.deepEqual(result.browse.unmatched, [], 'aucun point du BMS sans objet BACnet');
        assert.equal(result.browse.unbound.length, 0, 'aucun objet BACnet orphelin');
    }, { timeout: 90000 });

    test('les valeurs lues alimentent la table bacnetPoints', async () => {
        const points = ctx.global.get('bacnetPoints');
        const temp = points.f1_lobby_temp.value;

        assert.equal(typeof temp, 'number');
        assert.ok(temp > 5 && temp < 40, `température plausible attendue, obtenu ${temp}`);
        // Arrondi au dixième : sans cela, le flottant 32 bits BACnet remonterait
        // 21.299999237060547 jusque dans l'interface.
        assert.equal(temp, Math.round(temp * 10) / 10, 'la valeur doit être arrondie au dixième');

        assert.equal(typeof points.f1_lobby_motion.value, 'boolean', 'un binaire reste booléen');
    });

    test('l’état d’un point porte un horodatage', () => {
        const st = driver.read('f1_lobby_temp');
        assert.equal(st.quality, 'good');
        assert.ok(st.ts !== null && Date.now() - st.ts < 60000);
    });
});

describe('Écritures', () => {
    test('une consigne est écrite avec priorité et relue', async () => {
        const res = await driver.write('f1_lobby_temp_setpoint', 24, { priority: 8 });
        assert.equal(res.ok, true, res.error);

        await driver.refreshAll();
        const points = ctx.global.get('bacnetPoints');
        assert.equal(points.f1_lobby_temp_setpoint.value, 24,
            'le serveur doit avoir retenu la consigne');
    }, { timeout: 30000 });

    test('un actionneur binaire bascule', async () => {
        const res = await driver.write('f1_lobby_lamp', true);
        assert.equal(res.ok, true, res.error);

        await driver.refreshAll();
        assert.equal(ctx.global.get('bacnetPoints').f1_lobby_lamp.value, true);

        await driver.write('f1_lobby_lamp', false);
        await driver.refreshAll();
        assert.equal(ctx.global.get('bacnetPoints').f1_lobby_lamp.value, false);
    }, { timeout: 30000 });

    test('écrire sur une mesure est refusé, pas silencieusement ignoré', async () => {
        // Les capteurs sont des Analog/Binary Input : non inscriptibles, comme
        // sur un automate réel. Les rendre inscriptibles fige la valeur dans le
        // tableau de priorités et empêche la physique de la reprendre.
        const res = await driver.write('f1_lobby_temp', 30);
        assert.equal(res.ok, false);
        assert.match(res.error, /lecture seule|refus/i);
    });

    test('un point inconnu est refusé', async () => {
        const res = await driver.write('point_inexistant', 1);
        assert.equal(res.ok, false);
        assert.match(res.error, /non lié/);
    });
});

describe('Notifications COV', () => {
    test('la physique du serveur remonte sans interrogation', async () => {
        const before = driver.status().covReceived;

        // La physique fait dériver les températures toutes les 1,5 s. On attend
        // des notifications SANS appeler refreshAll : c'est tout l'intérêt.
        const after = await eventually(async () => {
            const n = driver.status().covReceived;
            return n > before ? n : null;
        }, { timeout: 20000, label: 'réception de notifications COV' });

        assert.ok(after > before, `COV reçues : ${before} → ${after}`);
    }, { timeout: 40000 });

    test('une commande écrite par le BMS influence la physique du serveur', async () => {
        // Consigne haute : le serveur doit chauffer la zone de lui-même.
        const points = ctx.global.get('bacnetPoints');
        const start = points.f2_off1_temp.value;

        await driver.write('f2_off1_temp_setpoint', 27);

        const warmed = await eventually(async () => {
            await driver.refreshAll();
            const now = ctx.global.get('bacnetPoints').f2_off1_temp.value;
            return now > start + 0.3 ? now : null;
        }, { timeout: 45000, label: 'réchauffement de la zone par le serveur' });

        assert.ok(warmed > start, `la zone doit se réchauffer : ${start} → ${warmed}`);
    }, { timeout: 90000 });
});

describe('Profils COV', () => {
    const round1 = (n) => Math.round(n * 10) / 10;

    /** Ce que le SERVEUR croit devoir à chaque abonné. */
    async function serverSubscriptions() {
        const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/covsubs`);
        return res.json();
    }

    test('les capacités de l’appareil sont lues, pas supposées', () => {
        const caps = driver.capabilities();
        assert.equal(caps.subscribeCovProperty, true,
            'le simulateur annonce SubscribeCOVProperty dans Protocol_Services_Supported');
        assert.equal(caps.covIncrementSettable, true,
            'donc l’interface doit proposer les réglages d’incrément : ' + caps.reason);
    });

    test('l’incrément voyage dans l’abonnement, point par point', async () => {
        // Un profil creux sur le ppm, affecté par étiquette, plus une surcharge
        // par point : les trois niveaux de précédence en une seule vérification.
        ctx.cov.setProfile({ name: 'CO2 fin', increments: { ppm: 5 } });
        ctx.cov.setAssignments([{ tag: 'co2', profile: 'CO2 fin' }]);
        ctx.cov.setProfile({ name: 'temp grossier', increments: { '°C': 3 } });
        ctx.cov.setOverride('f1_lobby_temp', 'temp grossier');

        const res = await driver.applyCovPolicy({ force: true });
        assert.equal(res.failed, 0, 'le serveur doit accepter les abonnements : ' + JSON.stringify(res.errors));
        assert.equal(res.service, 'SubscribeCOVProperty');
        assert.ok(res.written > 50, `points réabonnés : ${res.written}`);
        assert.equal(res.skipped, 25, 'les 25 binaires n’ont pas d’incrément — toute transition notifie');

        const { supported, subscriptions } = await serverSubscriptions();
        assert.equal(supported, true);
        assert.equal(subscriptions.length, 86,
            'un abonnement par point, et pas un de plus : l’identifiant de processus est stable');

        const cases = [
            ['f1_lobby_temp', 3, 'manual'],
            ['f1_lobby_co2', 5, 'tag:co2'],
            ['f2_off1_temp', 0.2, 'default'],
        ];
        for (const [id, expected, source] of cases) {
            assert.equal(ctx.cov.resolve(id).source, source, `provenance de ${id}`);
            const sub = subscriptions.find((s) => s.point === id);
            assert.ok(sub, `aucun abonnement pour ${id}`);
            // BACnet REAL est un flottant 32 bits : 0.2 revient en 0.20000000298.
            assert.equal(round1(sub.increment), expected,
                `l’abonnement de ${id} doit porter un incrément de ${expected}`);
        }
    }, { timeout: 60000 });

    test('deux abonnés au même point avec des seuils différents ne se gênent pas', async () => {
        // C'est tout l'intérêt de l'incrément par abonnement, et ce qu'une bande
        // morte posée sur l'objet ne sait pas faire : elle vaudrait pour les deux.
        ctx.cov.setProfile({ name: 'très fin', increments: { '°C': 0.1 } });
        ctx.cov.setOverride('f3_off2_temp', 'très fin');
        await driver.applyCovPolicy();

        const b = driver.bindings.get('f3_off2_temp');
        let otherCount = 0;
        const other = new bacnetClient.default({
            port: PROBE_PORT, interface: '127.0.0.1', broadcastAddress: '127.255.255.255',
        });
        other.on('covNotifyUnconfirmed', () => { otherCount++; });
        try {
            // Un second superviseur, seuil très grossier, sur LE MÊME point.
            await subscribeCovProperty(other, { address: `127.0.0.1:${SERVER_PORT}` },
                b.objectId, 85 /* present-value */, 991,
                { increment: 25, lifetime: 300, confirmed: false });

            const subs = (await serverSubscriptions()).subscriptions
                .filter((s) => s.point === 'f3_off2_temp');
            assert.equal(subs.length, 2, 'le serveur tient deux abonnements distincts sur ce point');
            assert.deepEqual(subs.map((s) => round1(s.increment)).sort((x, y) => x - y), [0.1, 25]);

            // Faire bouger la zone : seul l'abonné fin doit être servi.
            await driver.write('f3_off2_temp_setpoint', 27);
            const mine = driver.counts()['f3_off2_temp'] || 0;
            await sleep(18000);
            const mineDelta = (driver.counts()['f3_off2_temp'] || 0) - mine;

            assert.ok(mineDelta >= 3, `notre abonnement à 0,1 °C doit être servi (${mineDelta})`);
            // 1 = la notification initiale de l'abonnement, envoyée à la souscription.
            assert.ok(otherCount <= 1,
                `l’abonné à 25 °C ne doit rien recevoir au-delà de sa valeur initiale (${otherCount})`);
        } finally {
            other.close();
            ctx.cov.setOverride('f3_off2_temp', null);
            await driver.applyCovPolicy();
        }
    }, { timeout: 90000 });

    test('une bande morte grossière fait taire un point que la fine rapporte', async () => {
        // Deux zones que la physique fait bouger de la même façon, réglées à
        // l'opposé. C'est la mesure de ce que les profils achètent réellement.
        ctx.cov.setProfile({ name: 'très fin', increments: { '°C': 0.1 } });
        ctx.cov.setProfile({ name: 'très grossier', increments: { '°C': 20 } });
        ctx.cov.setOverride('f2_off2_temp', 'très fin');
        ctx.cov.setOverride('f2_off3_temp', 'très grossier');
        await driver.applyCovPolicy({ force: true });

        // Consignes hautes : les deux zones se mettent à chauffer.
        await driver.write('f2_off2_temp_setpoint', 28);
        await driver.write('f2_off3_temp_setpoint', 28);

        const before = driver.counts();
        await sleep(24000);          // ~16 ticks de physique à 1,5 s
        const after = driver.counts();
        const delta = (id) => (after[id] || 0) - (before[id] || 0);

        assert.ok(delta('f2_off2_temp') >= 3,
            `le point à 0,1 °C doit rapporter (${delta('f2_off2_temp')} notification(s))`);
        // Au plus UNE : la notification initiale part à la souscription et fixe
        // la référence de l'abonnement ; ensuite le seuil s'applique vraiment.
        assert.ok(delta('f2_off3_temp') <= 1,
            `le point à 20 °C doit se taire après sa notification initiale ` +
            `(${delta('f2_off3_temp')} notification(s))`);
        assert.ok(delta('f2_off2_temp') > delta('f2_off3_temp'),
            'la bande morte doit produire un écart mesurable entre les deux points');

        // Et le taux mesuré, celui que la colonne « notif/min » affiche, doit
        // classer le bavard devant le silencieux.
        const rates = driver.rates();
        assert.ok(rates['f2_off2_temp'] > 0, 'taux mesuré nul sur un point qui notifie');
        assert.equal(typeof rates['f2_off3_temp'], 'number');
    }, { timeout: 90000 });

    test('la table locale suit malgré la bande morte, à la bande morte près', async () => {
        // Une bande morte n'est pas une perte de valeur : c'est un retard borné.
        // Le point à 20 °C ne bouge plus, donc la table garde sa dernière valeur
        // connue — ce que `pointStaleAfter` est là pour signaler, pas le pilote.
        const points = ctx.global.get('bacnetPoints');
        assert.equal(typeof points.f2_off3_temp.value, 'number');

        // Retour à un réglage sain, et la valeur se remet à suivre.
        ctx.cov.setOverride('f2_off3_temp', null);
        await driver.applyCovPolicy({ force: true });
        const seen = ctx.global.get('bacnetPoints').f2_off3_temp.value;

        const moved = await eventually(async () => {
            const now = ctx.global.get('bacnetPoints').f2_off3_temp.value;
            return now !== seen ? now : null;
        }, { timeout: 30000, label: 'reprise des notifications après retour au socle' });
        assert.notEqual(moved, seen);
    }, { timeout: 60000 });
});

describe('Perte de connexion', () => {
    test('la qualité se dégrade quand le serveur disparaît', async () => {
        driver.disconnect();

        const st = driver.read('f1_lobby_temp');
        assert.equal(st.quality, 'unreliable',
            'déconnecté, la dernière valeur connue ne doit plus être présentée comme fiable');

        const res = await driver.write('f1_lobby_lamp', true);
        assert.equal(res.ok, false);
        assert.match(res.error, /non connecté/);
    });
});


describe('Automate sans SubscribeCOVProperty', () => {
    // Un contrôleur qui n'implémente pas le service est le cas courant. Le BMS
    // doit alors le DIRE et masquer ses réglages d'incrément, sans pour autant
    // perdre les valeurs : on retombe sur SubscribeCOV simple.
    const PORT = 47825, CLIENT = 47826, CONTROL = 47827, DEV = 4322;
    let plainServer, plainCtx, plainDriver;

    before(async () => {
        plainServer = spawn('node', [
            path.join(REPO, 'lib/bacnet-sim/server.js'),
            '--port', String(PORT), '--device-id', String(DEV),
            '--control-port', String(CONTROL),
            '--interface', '127.0.0.1', '--tick', '1500',
            '--no-cov-property', '--quiet',
        ], { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
        await sleep(2500);
        plainCtx = fakeContext();
        plainDriver = createBacnetDriver(plainCtx, {
            host: '127.0.0.1', port: PORT, clientPort: CLIENT, deviceId: DEV,
            interface: '127.0.0.1', broadcastAddress: '127.255.255.255', covLifetime: 300,
        });
        await plainDriver.connect();
    }, { timeout: 90000 });

    after(async () => {
        if (plainDriver) plainDriver.disconnect();
        if (plainServer && plainServer.exitCode === null) plainServer.kill('SIGTERM');
        await sleep(500);
    });

    test('le pilote le détecte et l’annonce', () => {
        const caps = plainDriver.capabilities();
        assert.equal(caps.subscribeCovProperty, false);
        assert.equal(caps.covIncrementSettable, false,
            'l’interface doit masquer les réglages d’incrément');
        assert.match(caps.reason, /n'annonce pas SubscribeCOVProperty/);
    });

    test('appliquer un profil ne prétend pas avoir réglé quoi que ce soit', async () => {
        plainCtx.cov.setProfile({ name: 'fin', increments: { '°C': 0.1 } });
        plainCtx.cov.setOverride('f1_lobby_temp', 'fin');

        const res = await plainDriver.applyCovPolicy({ force: true });
        assert.equal(res.unsupported, true);
        assert.equal(res.written, 0, 'rien ne doit être annoncé comme posé');
        assert.equal(plainDriver.appliedIncrement('f1_lobby_temp'), null,
            'aucun incrément porté par l’abonnement — la colonne doit rester vide');
    });

    test('les valeurs arrivent quand même, par SubscribeCOV simple', async () => {
        const before = plainDriver.status().covReceived;
        const after = await eventually(async () => {
            const n = plainDriver.status().covReceived;
            return n > before ? n : null;
        }, { timeout: 25000, label: 'notifications COV en mode dégradé' });
        assert.ok(after > before, 'perdre le réglage ne doit pas faire perdre les mesures');

        const temp = plainCtx.global.get('bacnetPoints').f1_lobby_temp.value;
        assert.equal(typeof temp, 'number');
        assert.ok(temp > 5 && temp < 40);
    }, { timeout: 60000 });
});
