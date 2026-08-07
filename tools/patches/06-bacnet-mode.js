'use strict';
/*
 * Patch — mode BACnet : dispatch asynchrone, enregistrement du pilote, API.
 *
 * Trois changements liés :
 *
 *  1. « Safety Guard », point de dispatch unique des commandes de règles, passe
 *     par writeValueAsync. En simulé cela ne change rien ; en BACnet, une
 *     écriture est une requête réseau qui peut échouer, et le refus doit être
 *     visible dans le journal des commandes plutôt qu'avalé.
 *
 *  2. Le pilote BACnet s'enregistre au démarrage et le mode est restauré.
 *
 *  3. Endpoints /bms/bacnet (état, mode, connexion, parcours).
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dispatch asynchrone
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInFunc(flows, 'Safety Guard',
`const success = BMS.writeValue(msg.payload.id, targetValue);
if (success) {
    node.status({ fill: 'green', shape: 'dot', text: msg.payload.id + ' = ' + targetValue });
    return { payload: 'updated', id: msg.payload.id, value: targetValue };
} else {
    node.status({ fill: 'yellow', shape: 'ring', text: msg.payload.id + ' - write failed' });
}
return null;`,
`// Écriture par la couche pilote. En mode simulé elle aboutit dans le tick
// courant ; en mode BACnet c'est une requête réseau qui peut échouer, expirer
// ou être refusée par l'automate. On n'attend pas la confirmation (le moteur de
// règles est en « tire et oublie »), mais tout échec est tracé.
const pointId = msg.payload.id;
BMS.writeValueAsync(pointId, targetValue)
    .then(res => {
        if (res && res.ok) {
            node.status({ fill: 'green', shape: 'dot', text: pointId + ' = ' + targetValue });
        } else {
            const why = (res && res.error) || 'refusé';
            node.status({ fill: 'yellow', shape: 'ring', text: pointId + ' — ' + why });
            const safety = global.get('bmsSafety');
            if (safety) safety.record(pointId, targetValue, 'rule', { ok: false, error: why });
        }
    })
    .catch(e => {
        node.status({ fill: 'red', shape: 'ring', text: pointId + ' — ' + e.message });
        const safety = global.get('bmsSafety');
        if (safety) safety.record(pointId, targetValue, 'rule', { ok: false, error: e.message });
    });

return { payload: 'commanded', id: pointId, value: targetValue };`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Endpoints /bms/bacnet
// ─────────────────────────────────────────────────────────────────────────────

const handler = `// Optional auth: if BMS_API_TOKEN env var is set on the Node-RED process,
// require it in the x-bms-token header (endpoints are otherwise open like the dashboard)
const required = env.get('BMS_API_TOKEN');
if (required && (!msg.req || msg.req.headers['x-bms-token'] !== required)) {
    msg.statusCode = 401;
    msg.payload = { error: 'unauthorized' };
    return msg;
}

const core = global.get('bmsCore');
const io = global.get('ioDrivers');
if (!core || !io) {
    msg.statusCode = 503;
    msg.payload = { error: 'BMS not initialised' };
    return msg;
}

const SIM_DEFAULTS = { host: '127.0.0.1', port: 47810, deviceId: 1234 };

function state() {
    const mode = global.get('bacnetMode') || 'internal';
    const target = global.get('bacnetTarget') || null;
    const driver = io.driverOrNull ? io.driverOrNull('bacnet') : null;
    const bacnetPoints = global.get('bacnetPoints') || {};
    return {
        mode: mode,                       // 'internal' | 'simulated' | 'real'
        target: target,
        simDefaults: SIM_DEFAULTS,
        driver: driver ? driver.status() : { connected: false },
        pointCount: Object.keys(bacnetPoints).length,
        physicsLocal: mode === 'internal'
    };
}

const method = ((msg.req && msg.req.method) || 'GET').toUpperCase();
const q = (msg.req && msg.req.query) || {};

if (method === 'GET') {
    if (q.browse === 'true') {
        const driver = io.driverOrNull && io.driverOrNull('bacnet');
        if (!driver || !driver.status().connected) {
            msg.statusCode = 409;
            msg.payload = { error: 'aucun serveur BACnet connecté' };
            return msg;
        }
        // Parcours à la demande : renvoie les objets du device et leur liaison.
        return driver.browse().then(objects => {
            const boundNames = new Set([...driver.bindings.keys()]);
            msg.payload = {
                deviceId: driver.status().deviceId,
                count: objects.length,
                objects: objects.map(o => ({
                    type: o.type, instance: o.instance, name: o.name,
                    description: o.description, writable: o.writable,
                    boundTo: boundNames.has(o.name) ? o.name : null
                }))
            };
            return msg;
        }).catch(e => {
            msg.statusCode = 502;
            msg.payload = { error: 'parcours impossible : ' + e.message };
            return msg;
        });
    }
    msg.payload = state();
    return msg;
}

// POST — changement de mode / connexion
const body = msg.payload || {};
const mode = body.mode;
if (!['internal', 'simulated', 'real'].includes(mode)) {
    msg.statusCode = 400;
    msg.payload = { error: "mode must be 'internal', 'simulated' or 'real'" };
    return msg;
}

const previous = io.driverOrNull && io.driverOrNull('bacnet');
if (previous) { try { previous.disconnect(); } catch (e) { /* déjà fermé */ } }

if (mode === 'internal') {
    global.set('bacnetMode', 'internal');
    global.set('defaultDriver', 'simulator');
    global.set('bacnetTarget', null);
    try { global.set('bacnetMode', 'internal', 'file'); } catch (e) {}
    node.warn('Mode BACnet : simulation interne (aucun réseau)');
    msg.payload = state();
    return msg;
}

const target = (mode === 'simulated')
    ? Object.assign({}, SIM_DEFAULTS, { host: body.host || SIM_DEFAULTS.host })
    : { host: body.host, port: Number(body.port) || 47808, deviceId: (body.deviceId === undefined || body.deviceId === null || body.deviceId === '') ? null : Number(body.deviceId) };

if (!target.host) {
    msg.statusCode = 400;
    msg.payload = { error: "l'adresse du serveur BACnet est requise (IP ou nom d'hôte)" };
    return msg;
}

let driver;
try {
    driver = core.createBacnetDriver({ global: global, node: node }, {
        host: target.host, port: target.port, deviceId: target.deviceId,
        clientPort: Number(body.clientPort) || 47809,
        interface: body.interface || '0.0.0.0'
    });
} catch (e) {
    msg.statusCode = 500;
    msg.payload = { error: e.message };
    return msg;
}

return driver.connect().then(result => {
    io.register('bacnet', driver);
    global.set('defaultDriver', 'bacnet');
    global.set('bacnetMode', mode);
    global.set('bacnetTarget', target);
    try {
        global.set('bacnetMode', mode, 'file');
        global.set('bacnetTarget', target, 'file');
    } catch (e) { /* file store not configured */ }
    node.warn('Mode BACnet : ' + mode + ' — ' + target.host + ':' + target.port +
              ' · ' + result.bound + ' points liés, ' + result.cov.ok + ' souscriptions COV');
    msg.payload = Object.assign(state(), { connectResult: result });
    return msg;
}).catch(e => {
    try { driver.disconnect(); } catch (err) {}
    msg.statusCode = 502;
    msg.payload = { error: 'connexion impossible : ' + e.message, target: target };
    return msg;
});`;

fk.addNodes(flows, [
    {
        id: 'bms_api_in_bacnet_get', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'GET /bms/bacnet', url: '/bms/bacnet', method: 'get',
        upload: false, swaggerDoc: '', x: 190, y: 1790, wires: [['bms_api_fn_bacnet']],
    },
    {
        id: 'bms_api_in_bacnet_post', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'POST /bms/bacnet', url: '/bms/bacnet', method: 'post',
        upload: false, swaggerDoc: '', x: 190, y: 1830, wires: [['bms_api_fn_bacnet']],
    },
    {
        id: 'bms_api_fn_bacnet', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'API: bacnet', func: handler, outputs: 1, timeout: 0,
        noerr: 0, initialize: '', finalize: '', libs: [],
        x: 470, y: 1810, wires: [['bms_api_response']],
    },
]);

const apiGroup = fk.byId(flows, 'grp_bms_api');
apiGroup.nodes.push('bms_api_in_bacnet_get', 'bms_api_in_bacnet_post', 'bms_api_fn_bacnet');
apiGroup.h = (apiGroup.h || 200) + 90;

for (const name of ['Safety Guard', 'API: bacnet']) {
    const n = fk.node(flows, name);
    try {
        new Function('msg', 'node', 'global', 'flow', 'env', 'context', 'RED', 'util', n.func);
    } catch (e) {
        throw new Error(`${name} : syntaxe invalide — ${e.message}`);
    }
}

fk.save(flows);
console.log('mode BACnet câblé —', fk.summary(flows).nodes, 'nœuds');
