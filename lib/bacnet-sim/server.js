'use strict';
/*
 * Serveur BACnet/IP de test — le bâtiment simulé, sur le réseau.
 *
 * Processus séparé du BMS. Il expose les 86 points comme de vrais objets
 * BACnet, répond au parcours (Who-Is, object-list, ReadProperty, RPM), accepte
 * les écritures avec priorité, et émet des notifications COV quand la physique
 * fait bouger les valeurs.
 *
 * Pourquoi un processus séparé : le but est de tester le CLIENT BACnet du BMS
 * contre quelque chose qui se comporte comme un automate. Un simulateur en
 * mémoire partagée ne teste pas l'encodage, le réseau, les délais, ni la
 * reprise après coupure. Ici, débrancher le simulateur ressemble vraiment à un
 * automate qui tombe.
 *
 *   node lib/bacnet-sim/server.js [--port 47810] [--device-id 1234]
 *                                 [--interface 127.0.0.1] [--tick 2000]
 *
 * Convention de nommage : l'`object-name` de chaque objet EST l'identifiant du
 * fait côté BMS (`f1_lobby_temp`). C'est la clé de liaison — le client parcourt
 * les objets, lit leurs noms, et retrouve ses points sans table manuelle. Un
 * automate réel n'aura pas cette politesse : sa page de liaison sert à ça.
 */

const http = require('node:http');

const { BDDevice, BDAnalogInput, BDAnalogValue, BDBinaryValue } = require('@bacnet-js/device');
const { EngineeringUnits, BinaryPV } = require('@bacnet-js/client');

const installPoints = require('../bms-core/points');
const { runPhysicsTick } = require('./physics');

// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = { port: 47810, deviceId: 1234, interface: '0.0.0.0', tick: 2000,
                   controlPort: 47811, quiet: false };
    for (let i = 2; i < argv.length; i++) {
        const [k, inlineV] = argv[i].split('=');
        const next = () => (inlineV !== undefined ? inlineV : argv[++i]);
        switch (k) {
            case '--port': opts.port = Number(next()); break;
            case '--device-id': opts.deviceId = Number(next()); break;
            case '--interface': opts.interface = next(); break;
            case '--tick': opts.tick = Number(next()); break;
            case '--control-port': opts.controlPort = Number(next()); break;
            case '--quiet': opts.quiet = true; break;
            case '--help':
                console.log('usage: node server.js [--port 47810] [--device-id 1234] ' +
                            '[--interface 0.0.0.0] [--tick 2000] [--control-port 47811] [--quiet]');
                process.exit(0);
                break;
            default: throw new Error('option inconnue : ' + k);
        }
    }
    return opts;
}

/** Charge les tables de points en réutilisant le module du cœur BMS. */
function loadTables() {
    const store = new Map();
    const fakeCtx = {
        global: {
            get: (k, s) => store.get((s || 'default') + ':' + k),
            set: (k, v, s) => store.set((s || 'default') + ':' + k, v),
        },
        node: { warn() {}, error() {}, status() {} },
        env: { get: () => undefined },
    };
    return installPoints(fakeCtx);
}

const UNIT_MAP = {
    '°C': EngineeringUnits.DEGREES_CELSIUS,
    '%': EngineeringUnits.PERCENT,
    'ppm': EngineeringUnits.PARTS_PER_MILLION,
    'lux': EngineeringUnits.LUXES,
};

/**
 * Crée un objet BACnet par point.
 *   - booléen              → Binary Value (inscriptible si read_write)
 *   - numérique read_only  → Analog Input  (une mesure)
 *   - numérique read_write → Analog Value  (une consigne)
 */
function buildObjects(device, bacnetPoints) {
    const objects = new Map();       // factId → { object, isBool, writable }

    for (const [factId, p] of Object.entries(bacnetPoints)) {
        const writable = p.access === 'read_write';
        const isBool = p.units === 'bool' || typeof p.value === 'boolean';
        let object;

        // Les mesures restent en LECTURE SEULE, comme sur un automate réel.
        //
        // Tentative abandonnée : les rendre inscriptibles pour que le panneau
        // « Sensor Simulation » les pilote. Une écriture client se pose dans le
        // tableau de priorités (priorité 8) et y RESTE : la physique du serveur
        // ne peut plus bouger le point, la valeur forcée est figée à vie. C'est
        // le comportement BACnet correct pour une commande, et c'est exactement
        // ce qu'on ne veut pas d'une mesure.
        if (isBool) {
            object = new BDBinaryValue({
                name: factId,
                description: p.objectName || factId,
                writable,
                presentValue: p.value ? BinaryPV.ACTIVE : BinaryPV.INACTIVE,
            });
        } else {
            const opts = {
                name: factId,
                description: p.objectName || factId,
                presentValue: typeof p.value === 'number' ? p.value : 0,
                unit: UNIT_MAP[p.units] ?? EngineeringUnits.NO_UNITS,
            };
            if (p.min !== undefined) opts.minPresentValue = p.min;
            if (p.max !== undefined) opts.maxPresentValue = p.max;
            object = writable ? new BDAnalogValue({ ...opts, writable: true })
                              : new BDAnalogInput(opts);
        }

        device.addObject(object);
        objects.set(factId, { object, isBool, writable });
    }
    return objects;
}

/** BACnet REAL est un flottant 32 bits : 21.3 revient en 21.299999237060547. */
const round1 = (n) => Math.round(n * 10) / 10;

function start(opts) {
    const { bacnetPoints, bmsMetadata } = loadTables();

    const device = new BDDevice(opts.deviceId, {
        name: 'AI-BMS-SIMULATOR',
        description: 'Bâtiment simulé — 3 étages, 13 zones',
        port: opts.port,
        interface: opts.interface,
        vendorId: 260,
        vendorName: 'AI BMS',
        modelName: 'Physics Simulator',
        firmwareRevision: '1.0.0',
        applicationSoftwareVersion: '1.0.0',
    });

    const objects = buildObjects(device, bacnetPoints);

    const say = (...a) => { if (!opts.quiet) console.log(...a); };
    say(`Serveur BACnet/IP « AI-BMS-SIMULATOR »`);
    say(`  device ${opts.deviceId} · ${opts.interface}:${opts.port} · ${objects.size} objets`);
    say(`  physique toutes les ${opts.tick} ms · object-name = identifiant du fait`);

    let ticks = 0;

    const tick = () => {
        ticks++;
        try {
            // 1. Reprendre ce que le réseau a commandé sur les actionneurs :
            //    c'est une donnée d'entrée pour le tick de physique qui suit.
            for (const [factId, { object, isBool, writable }] of objects) {
                if (!writable) continue;
                const pv = object.presentValue.getValue();
                const value = isBool ? (pv === BinaryPV.ACTIVE) : round1(pv);
                if (bacnetPoints[factId] && bacnetPoints[factId].value !== value) {
                    bacnetPoints[factId].value = value;
                }
            }

            // 2. Faire avancer le bâtiment.
            const result = runPhysicsTick(bacnetPoints, bmsMetadata);

            // 3. Republier les mesures calculées : c'est ce qui déclenche les
            //    notifications COV vers les clients abonnés.
            for (const [factId, { object, isBool, writable }] of objects) {
                if (writable) continue;
                const p = bacnetPoints[factId];
                if (!p) continue;
                if (isBool) {
                    const want = p.value ? BinaryPV.ACTIVE : BinaryPV.INACTIVE;
                    if (object.presentValue.getValue() !== want) object.presentValue.setValue(want);
                } else {
                    const want = round1(p.value);
                    if (round1(object.presentValue.getValue()) !== want) object.presentValue.setValue(want);
                }
            }

            if (!opts.quiet && ticks % 30 === 0) {
                say(`  tick ${ticks} · ${result.changes} changements · ${result.zoneCount} zones ` +
                    `· ${result.outsideTemp.toFixed(1)}°C dehors`);
            }
        } catch (e) {
            console.error('erreur de tick :', e.message);
        }
    };

    // ── Canal de contrôle hors-bande ────────────────────────────────────────
    //
    // Le panneau « Sensor Simulation » pilote le SIMULATEUR, pas un automate.
    // Passer par BACnet pour forcer une présence n'aurait pas de sens : sur le
    // réseau, un capteur est une entrée en lecture seule, et c'est correct.
    // Mais un simulateur doit pouvoir être piloté — c'est sa raison d'être.
    //
    // Ce petit canal HTTP est donc l'équivalent du technicien qui souffle sur
    // la sonde : il agit sur le modèle physique, en amont de BACnet. La valeur
    // forcée devient l'entrée du prochain tick, et repart ensuite vers les
    // clients par notification COV, comme n'importe quelle mesure.
    const control = http.createServer((req, res) => {
        const send = (code, body) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && req.url.startsWith('/state')) {
            const out = {};
            for (const [id, p] of Object.entries(bacnetPoints)) out[id] = p.value;
            return send(200, { deviceId: opts.deviceId, points: out });
        }
        if (req.method !== 'POST' || !req.url.startsWith('/force')) {
            return send(404, { error: 'POST /force {id,value} · GET /state' });
        }
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
        req.on('end', () => {
            let body;
            try { body = JSON.parse(raw || '{}'); } catch (e) { return send(400, { error: 'JSON invalide' }); }
            const { id, value } = body;
            if (!id || value === undefined) return send(400, { error: 'attendu {id, value}' });
            const p = bacnetPoints[id];
            if (!p) return send(404, { error: 'point inconnu : ' + id });

            const isBool = typeof p.value === 'boolean';
            let v = isBool ? Boolean(value) : Number(value);
            if (!isBool) {
                if (Number.isNaN(v)) return send(400, { error: 'valeur numérique attendue' });
                if (p.min !== undefined && v < p.min) v = p.min;
                if (p.max !== undefined && v > p.max) v = p.max;
            }
            p.value = v;

            // Publier immédiatement : le client abonné doit voir le changement
            // sans attendre le prochain tick.
            const entry = objects.get(id);
            if (entry) {
                const want = entry.isBool ? (v ? BinaryPV.ACTIVE : BinaryPV.INACTIVE) : round1(v);
                if (entry.object.presentValue.getValue() !== want) entry.object.presentValue.setValue(want);
            }
            send(200, { ok: true, id, value: v });
        });
    });
    control.listen(opts.controlPort, opts.interface === '0.0.0.0' ? undefined : opts.interface, () => {
        say(`  canal de contrôle du simulateur : http://${opts.interface}:${opts.controlPort}/force`);
    });

    const timer = setInterval(tick, opts.tick);
    tick();

    const shutdown = () => {
        clearInterval(timer);
        try { control.close(); } catch (e) { /* déjà fermé */ }
        say('\narrêt du serveur BACnet');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return { device, objects, bacnetPoints, stop: shutdown };
}

if (require.main === module) {
    try {
        start(parseArgs(process.argv));
    } catch (e) {
        console.error('démarrage impossible :', e.message);
        process.exit(1);
    }
}

module.exports = { start, loadTables, buildObjects };
