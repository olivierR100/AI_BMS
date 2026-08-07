'use strict';
/*
 * Test harness for the AI BMS.
 *
 * Two responsibilities:
 *   1. Instance lifecycle — spin a throwaway Node-RED on a free port, with its
 *      own userDir, so tests never touch ~/.node-red.
 *   2. A client for the /bms API with the waiting primitives the rule engine
 *      requires: rules fire on a ~1 s tick, so nearly every assertion is
 *      "eventually", never "immediately".
 *
 * No dependencies beyond Node 20 built-ins.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const REPO = path.resolve(__dirname, '..', '..');
const REAL_USERDIR = path.join(os.homedir(), '.node-red');

// ─────────────────────────────────────────────────────────────────────────────
// Petites utilités
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Client BMS
// ─────────────────────────────────────────────────────────────────────────────

class BmsClient {
    constructor(base) {
        this.base = base.replace(/\/$/, '');
    }

    async #json(method, urlPath, body) {
        const res = await fetch(`${this.base}${urlPath}`, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`${method} ${urlPath} → réponse non JSON (${res.status}): ${text.slice(0, 200)}`);
        }
        return { status: res.status, body: parsed };
    }

    async context()  { return (await this.#json('GET', '/bms/context')).body; }
    async firelog()  { return (await this.#json('GET', '/bms/firelog')).body; }
    async points()   { return (await this.#json('GET', '/bms/points')).body; }
    async point(id)  { return (await this.#json('GET', `/bms/points?id=${encodeURIComponent(id)}`)).body; }
    async syslog(q = '') { return (await this.#json('GET', `/bms/syslog${q}`)).body; }

    /** Profils COV : état complet, incréments effectifs et provenances inclus. */
    async covState() { return (await this.#json('GET', '/bms/cov')).body; }
    /** Édition des profils COV. Rend `{status, body}` : les refus sont testés. */
    async cov(body) { return this.#json('POST', '/bms/cov', body); }

    /**
     * Force un capteur, comme le ferait le panneau « Sensor Simulation ».
     *
     * En mode BACnet, cela passe par le canal de contrôle du simulateur : le
     * modèle physique est en amont du réseau, et écrire la table locale du BMS
     * ne ferait que diverger du serveur jusqu'à la prochaine notification COV.
     */
    async sensor(id, value) {
        if (this.controlPort) {
            const res = await fetch(`http://127.0.0.1:${this.controlPort}/force`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, value }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(`sensor(${id}) → ${JSON.stringify(body)}`);
            return body;
        }
        const r = await this.#json('POST', '/bms/points', { id, value, simulate: true });
        if (r.status !== 200) throw new Error(`sensor(${id}) → ${r.status} ${JSON.stringify(r.body)}`);
        return r.body;
    }

    /** Écriture normale à travers la couche BMS (droits + bornes appliqués). */
    async write(id, value) {
        return this.#json('POST', '/bms/points', { id, value });
    }

    async applyConfig(cfg) {
        const r = await this.#json('POST', '/bms/config', cfg);
        if (r.status !== 200) throw new Error(`applyConfig → ${r.status} ${JSON.stringify(r.body)}`);
        return r.body;
    }

    /**
     * Attend qu'un point atteigne une valeur. Le moteur tourne sur un tick de
     * ~1 s et la physique sur ~2 s : sans attente, tout test est instable.
     */
    async expectPoint(id, expected, { timeout = 15000, label = '' } = {}) {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
            const all = await this.points();
            last = all[id];
            if (last === expected) return last;
            await sleep(400);
        }
        throw new Error(
            `${label || id} : attendu ${JSON.stringify(expected)}, ` +
            `obtenu ${JSON.stringify(last)} après ${timeout} ms`,
        );
    }

    /** Variante prédicat, pour les cas non exactement égaux. */
    async expectPointWhere(id, predicate, { timeout = 15000, describe = 'prédicat' } = {}) {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
            const all = await this.points();
            last = all[id];
            if (predicate(last)) return last;
            await sleep(400);
        }
        throw new Error(`${id} : ${describe} non satisfait, dernière valeur ${JSON.stringify(last)}`);
    }

    /** Attend qu'une règle apparaisse dans le firelog avec un déclenchement. */
    async expectRuleFired(nameFragment, { timeout = 15000, since = 0 } = {}) {
        const deadline = Date.now() + timeout;
        let seen = [];
        while (Date.now() < deadline) {
            const fl = (await this.firelog()).fireLog || {};
            seen = Object.entries(fl).filter(([n]) => n.includes(nameFragment));
            const hit = seen.find(([, info]) => (info.lastFired || 0) >= since);
            if (hit) return hit[1];
            await sleep(400);
        }
        throw new Error(
            `aucune règle contenant « ${nameFragment} » n'a déclenché depuis ${since}. ` +
            `Correspondances vues : ${seen.map(([n]) => n).join(' | ') || 'aucune'}`,
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle de vie de l'instance de test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prépare un userDir jetable : flows et settings du dépôt, node_modules
 * partagés par lien symbolique avec l'installation réelle (sinon chaque test
 * paierait plusieurs minutes de npm install).
 */
function prepareUserDir(dir, port, { seed = true } = {}) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'context', 'global'), { recursive: true });

    fs.copyFileSync(path.join(REPO, 'flows.json'), path.join(dir, 'flows.json'));
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));

    const modules = path.join(REAL_USERDIR, 'node_modules');
    if (!fs.existsSync(modules)) {
        throw new Error(
            `node_modules introuvable dans ${REAL_USERDIR}. ` +
            `Lancez d'abord une installation complète (packaging/install.sh).`,
        );
    }
    fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');

    // settings.js du dépôt : version expurgée, avec les marqueurs à substituer.
    let settings = fs.readFileSync(path.join(REPO, 'settings.js'), 'utf8');
    settings = settings
        .replace('REPLACE_WITH_BCRYPT_HASH', '$2b$08$0000000000000000000000000000000000000000000000000000')
        .replace('REPLACE_WITH_STATIC_API_TOKEN', 'test-token-not-a-secret')
        .replace('uiPort: process.env.PORT || 1880', `uiPort: process.env.PORT || ${port}`);
    fs.writeFileSync(path.join(dir, 'settings.js'), settings);

    // Le lib/ du dépôt porte le cœur BMS extrait ; il doit suivre les flows.
    const libSrc = path.join(REPO, 'lib');
    if (fs.existsSync(libSrc)) {
        fs.cpSync(libSrc, path.join(dir, 'lib'), { recursive: true });
    }

    const seedFile = path.join(REPO, 'packaging', 'seed', 'global.json');
    const target = path.join(dir, 'context', 'global', 'global.json');
    if (seed && fs.existsSync(seedFile)) {
        fs.copyFileSync(seedFile, target);
    } else {
        fs.writeFileSync(target, '{}');
    }
}

/**
 * Démarre une instance et attend qu'elle serve l'API, que les règles soient
 * chargées et que les états internes soient enregistrés — sans quoi les
 * premiers tests courent contre un système à moitié éveillé.
 */
async function startInstance({ seed = true, quiet = true, bacnet = true } = {}) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bms-test-'));
    prepareUserDir(dir, port, { seed });

    // Serveur BACnet de test, un par instance. Les ports et l'identifiant de
    // device sont tirés à part pour que deux exécutions simultanées ne se
    // marchent pas dessus — c'est aussi pourquoi on se connecte en mode
    // « real » plutôt que « simulated » : ce dernier code en dur 47810/1234.
    let simChild = null;
    let simPort = null, controlPort = null, deviceId = null;
    if (bacnet) {
        simPort = await freePort();
        controlPort = await freePort();
        deviceId = 4000 + (simPort % 1000);
    }

    const logPath = path.join(dir, 'node-red.log');
    const log = fs.openSync(logPath, 'a');
    // cwd = dir : sans cela Node-RED résout `flowFile: 'flows.json'` depuis le
    // répertoire courant et charge le flows.json du dépôt au lieu de la copie
    // de test — l'instance semble correcte mais ne teste pas ce qu'on croit.
    const child = spawn('node-red', ['--userDir', dir, '--port', String(port)], {
        stdio: ['ignore', log, log],
        cwd: dir,
        detached: false,
    });

    if (bacnet) {
        simChild = spawn('node', [
            path.join(REPO, 'lib', 'bacnet-sim', 'server.js'),
            '--port', String(simPort),
            '--device-id', String(deviceId),
            '--control-port', String(controlPort),
            '--interface', '127.0.0.1',
            '--tick', '1500',
            '--quiet',
        ], { stdio: ['ignore', log, log], cwd: REPO });
    }

    const client = new BmsClient(`http://127.0.0.1:${port}`);
    client.controlPort = controlPort;   // force les capteurs via le simulateur
    const instance = {
        port, dir, child, client, logPath,
        simPort, controlPort, deviceId,
        readLog: () => fs.readFileSync(logPath, 'utf8'),

        /** Force un capteur par le canal de contrôle du simulateur. */
        async forceSensor(id, value) {
            const res = await fetch(`http://127.0.0.1:${controlPort}/force`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, value }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(`forceSensor(${id}) → ${JSON.stringify(body)}`);
            return body;
        },

        async stop() {
            for (const c of [simChild, child]) {
                if (c && c.exitCode === null && !c.killed) {
                    c.kill('SIGTERM');
                    for (let i = 0; i < 20 && c.exitCode === null; i++) await sleep(250);
                    if (c.exitCode === null) c.kill('SIGKILL');
                }
            }
            fs.closeSync(log);
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };

    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Node-RED s'est arrêté (code ${child.exitCode})\n${instance.readLog().slice(-2000)}`);
        }
        try {
            const fl = await client.firelog();
            const pts = await client.points();
            const rulesReady = !seed || (fl.rulesLoaded || 0) > 0;
            // Les points matériels suffisent comme signal de vie : les états
            // internes n'apparaissent qu'après le premier set_state, et un
            // bâtiment au repos peut n'en déclencher aucun.
            if (rulesReady && Object.keys(pts).length > 50) { ready = true; break; }
        } catch { /* pas encore debout */ }
        await sleep(500);
    }
    if (!ready) {
        const tail = instance.readLog().slice(-2000);
        await instance.stop();
        throw new Error(`instance non prête après 90 s\n${tail}`);
    }

    // Brancher le BMS sur le serveur BACnet de test. À partir de là les valeurs
    // arrivent par notification COV : c'est le chemin réel, celui qui remplacera
    // la table en mémoire.
    if (bacnet) {
        const deadline2 = Date.now() + 60000;
        let connected = false, lastError = null;
        while (Date.now() < deadline2) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/bms/bacnet`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'real', host: '127.0.0.1', port: simPort, deviceId,
                    }),
                });
                const body = await res.json();
                if (res.ok && body.driver && body.driver.connected) { connected = true; break; }
                lastError = body.error || JSON.stringify(body).slice(0, 200);
            } catch (e) { lastError = e.message; }
            await sleep(1000);
        }
        if (!connected) {
            const tail = instance.readLog().slice(-1500);
            await instance.stop();
            throw new Error(`connexion au serveur BACnet de test impossible : ${lastError}\n${tail}`);
        }
    }

    // Laisse un cycle de physique et un cycle de règles se produire.
    await sleep(3000);
    if (!quiet) {
        console.log(`  instance prête — Node-RED ${port}, BACnet ${simPort} (device ${deviceId})`);
    }
    return instance;
}

module.exports = { BmsClient, startInstance, prepareUserDir, freePort, sleep, REPO };
