'use strict';
/*
 * Patch — endpoint GET /bms/commandlog.
 *
 * La traçabilité ne sert que si elle se lit. Expose le journal des commandes
 * comme les autres diagnostics : ?n= pour la taille, ?id= pour un point,
 * ?source= pour l'origine.
 */

const fk = require('../flowkit');
const flows = fk.load();

const handler = `// Optional auth: if BMS_API_TOKEN env var is set on the Node-RED process,
// require it in the x-bms-token header (endpoints are otherwise open like the dashboard)
const required = env.get('BMS_API_TOKEN');
if (required && (!msg.req || msg.req.headers['x-bms-token'] !== required)) {
    msg.statusCode = 401;
    msg.payload = { error: 'unauthorized' };
    return msg;
}

const safety = global.get('bmsSafety');
if (!safety) {
    msg.statusCode = 503;
    msg.payload = { error: 'safety layer not initialised' };
    return msg;
}

const q = (msg.req && msg.req.query) || {};
let entries = safety.log();

if (q.id) entries = entries.filter(e => e.id === q.id);
if (q.source) entries = entries.filter(e => e.source === q.source);
if (q.failed === 'true') entries = entries.filter(e => !e.ok);

const n = q.n ? parseInt(q.n, 10) : 100;
entries = entries.slice(-Math.max(1, n));

msg.payload = {
    count: entries.length,
    rateLimit: global.get('writeRateLimit') || null,
    requireApprovalForRealPoints: global.get('requireApprovalForRealPoints') !== false,
    entries: entries.map(e => ({
        time: new Date(e.ts).toISOString(),
        id: e.id, value: e.value, source: e.source, ok: e.ok, error: e.error
    }))
};
return msg;`;

fk.addNodes(flows, [
    {
        id: 'bms_api_in_commandlog', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'GET /bms/commandlog', url: '/bms/commandlog', method: 'get',
        upload: false, swaggerDoc: '', x: 190, y: 1740, wires: [['bms_api_fn_commandlog']],
    },
    {
        id: 'bms_api_fn_commandlog', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'API: commandlog', func: handler, outputs: 1, timeout: 0,
        noerr: 0, initialize: '', finalize: '', libs: [],
        x: 470, y: 1740, wires: [['bms_api_response']],
    },
]);

const apiGroup = fk.byId(flows, 'grp_bms_api');
apiGroup.nodes.push('bms_api_in_commandlog', 'bms_api_fn_commandlog');
apiGroup.h = (apiGroup.h || 200) + 45;

fk.save(flows);
console.log('endpoint /bms/commandlog ajouté —', fk.summary(flows).nodes, 'nœuds');
