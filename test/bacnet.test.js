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

const { createBacnetDriver } = require('../lib/bms-core/drivers/bacnet');
const installPoints = require('../lib/bms-core/points');

const REPO = path.resolve(__dirname, '..');
const SERVER_PORT = 47820;
const CLIENT_PORT = 47821;
const CONTROL_PORT = 47822;   // distinct du simulateur de développement (47811)
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

