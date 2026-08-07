'use strict';
/*
 * Patch — suppression du mode « internal ».
 *
 * Deux sources de points (table en mémoire + serveur BACnet) doublaient chaque
 * chemin à maintenir. Le serveur BACnet simulé fait tout ce que faisait la
 * simulation interne, en exerçant en plus le vrai chemin réseau.
 *
 * Prérequis : le harnais de tests doit déjà passer en mode BACnet. C'est le cas
 * (55 tests verts) — les scénarios démarrent un serveur BACnet par exécution.
 *
 * Modes restants : `simulated` (serveur de test) et `real` (automate).
 * Au démarrage, le système tente le serveur simulé : sans cela un utilisateur
 * qui vient d'installer verrait un bâtiment figé sans explication.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─── 1. La physique n'a plus lieu d'être dans le flow ───────────────────────

const physGroup = fk.byId(flows, 'grp_physics');
const physInject = flows.find((n) => n.type === 'inject' && (n.wires || [])
    .some((w) => (w || []).includes('node_physics')));
const physNode = flows.find((n) => n.name === 'Physics Simulator');

const toRemove = [physNode.id];
if (physInject) toRemove.push(physInject.id);

physGroup.nodes = (physGroup.nodes || []).filter((id) => !toRemove.includes(id));
fk.removeNodes(flows, toRemove);
if (physGroup.nodes.length === 0) fk.removeNodes(flows, [physGroup.id]);

// ─── 2. Le forçage de capteur passe toujours par le simulateur ──────────────

fk.setFunc(flows, 'Write', `// Forçage d'un capteur depuis le panneau « Sensor Simulation ».
//
// Ce panneau pilote le SIMULATEUR PHYSIQUE, pas un automate. Passer par BACnet
// n'aurait pas de sens : sur le réseau une mesure est une entrée en lecture
// seule, et c'est correct. Mais un simulateur doit pouvoir être piloté — c'est
// sa raison d'être. On s'adresse donc à son canal de contrôle hors-bande, en
// amont de BACnet. La valeur repart ensuite vers le BMS par notification COV,
// comme n'importe quelle mesure.

if (msg.topic !== 'sensor_update') return null;

const { id, value } = msg.payload || {};
if (!id) return null;

const mode = global.get('bacnetMode');
const target = global.get('bacnetTarget') || {};

if (mode !== 'simulated') {
    node.status({ fill: 'yellow', shape: 'ring', text: 'capteurs non forçables' });
    node.warn(mode === 'real'
        ? 'Forçage refusé : « ' + id + ' » est une mesure d’un automate réel.'
        : 'Forçage impossible : aucun serveur BACnet connecté.');
    return null;
}

const url = 'http://' + (target.host || '127.0.0.1') + ':' + (target.controlPort || 47811) + '/force';
const fetchFn = global.get('fetchFn');

fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, value: value })
}).then(r => r.json().then(b => ({ ok: r.ok, b })))
  .then(({ ok, b }) => {
      if (ok) node.status({ fill: 'green', shape: 'dot', text: id + ' = ' + b.value });
      else {
          node.status({ fill: 'yellow', shape: 'ring', text: id + ' — ' + (b.error || 'refusé') });
          node.warn('forçage refusé par le simulateur : ' + (b.error || 'inconnu'));
      }
  })
  .catch(e => {
      node.status({ fill: 'red', shape: 'ring', text: 'simulateur injoignable' });
      node.warn('canal de contrôle du simulateur injoignable (' + url + ') : ' + e.message);
  });

return null;
`);

// ─── 3. L'API ne connaît plus que simulated et real ─────────────────────────

fk.replaceInFunc(flows, 'API: bacnet',
    `    const mode = global.get('bacnetMode') || 'internal';`,
    `    const mode = global.get('bacnetMode') || 'disconnected';`);

fk.replaceInFunc(flows, 'API: bacnet',
    `        mode: mode,                       // 'internal' | 'simulated' | 'real'`,
    `        mode: mode,                       // 'disconnected' | 'simulated' | 'real'`);

fk.replaceInFunc(flows, 'API: bacnet',
    `        pointCount: Object.keys(bacnetPoints).length,
        physicsLocal: mode === 'internal'`,
    `        pointCount: Object.keys(bacnetPoints).length`);

fk.replaceInFunc(flows, 'API: bacnet',
    `if (!['internal', 'simulated', 'real'].includes(mode)) {
    msg.statusCode = 400;
    msg.payload = { error: "mode must be 'internal', 'simulated' or 'real'" };
    return msg;
}`,
    `if (!['disconnected', 'simulated', 'real'].includes(mode)) {
    msg.statusCode = 400;
    msg.payload = { error: "mode must be 'simulated', 'real' or 'disconnected'" };
    return msg;
}`);

fk.replaceInFunc(flows, 'API: bacnet',
    `if (mode === 'internal') {
    global.set('bacnetMode', 'internal');
    global.set('defaultDriver', 'simulator');
    global.set('bacnetTarget', null);
    try { global.set('bacnetMode', 'internal', 'file'); } catch (e) {}
    node.warn('Mode BACnet : simulation interne (aucun réseau)');
    msg.payload = state();
    return msg;
}`,
    `if (mode === 'disconnected') {
    global.set('bacnetMode', 'disconnected');
    global.set('defaultDriver', 'simulator');
    global.set('bacnetTarget', null);
    try { global.set('bacnetMode', 'disconnected', 'file'); } catch (e) {}
    node.warn('Source de points déconnectée — les valeurs sont figées.');
    msg.payload = state();
    return msg;
}`);

// ─── 4. Connexion automatique au serveur simulé au démarrage ────────────────

const autoconnect = `// Au démarrage, tenter le serveur BACnet simulé.
//
// Sans le mode « internal », un système fraîchement installé n'a aucune source
// de points : le bâtiment paraît figé, sans explication. On réutilise le MÊME
// chemin que l'interface (POST /bms/bacnet) plutôt que de dupliquer la logique
// de connexion — un seul endroit où elle peut se tromper.
//
// Si un mode a été mémorisé au dernier arrêt, on le respecte.

const remembered = global.get('bacnetMode');
if (remembered === 'disconnected') {
    node.status({ fill: 'grey', shape: 'ring', text: 'déconnecté (mémorisé)' });
    return null;
}

const target = global.get('bacnetTarget') || {};
const body = (remembered === 'real' && target.host)
    ? { mode: 'real', host: target.host, port: target.port, deviceId: target.deviceId }
    : { mode: 'simulated' };

const fetchFn = global.get('fetchFn');
const port = env.get('PORT') || 1880;

fetchFn('http://127.0.0.1:' + port + '/bms/bacnet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
}).then(r => r.json().then(b => ({ ok: r.ok, b })))
  .then(({ ok, b }) => {
      if (ok) {
          node.status({ fill: 'green', shape: 'dot', text: b.mode + ' · ' + b.driver.bound + ' points' });
      } else {
          node.status({ fill: 'yellow', shape: 'ring', text: 'connexion impossible' });
          node.warn('Serveur BACnet injoignable au démarrage (' + (b.error || '') + '). ' +
                    'Lancez « bms-sim-start », puis connectez depuis la page BACnet Server.');
      }
  })
  .catch(e => {
      node.status({ fill: 'yellow', shape: 'ring', text: 'connexion impossible' });
      node.warn('Connexion BACnet au démarrage impossible : ' + e.message);
  });

return null;
`;

fk.addNodes(flows, [
    {
        id: 'bacnet_autoconnect_tick', type: 'inject', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'Connexion BACnet au boot', props: [{ p: 'payload' }],
        repeat: '', crontab: '', once: true, onceDelay: '8', topic: '',
        payload: '', payloadType: 'date',
        x: 200, y: 1880, wires: [['bacnet_autoconnect']],
    },
    {
        id: 'bacnet_autoconnect', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'Auto-connect BACnet', func: autoconnect, outputs: 1, timeout: 0,
        noerr: 0, initialize: '', finalize: '', libs: [],
        x: 480, y: 1880, wires: [[]],
    },
]);
const apiGroup = fk.byId(flows, 'grp_bms_api');
apiGroup.nodes.push('bacnet_autoconnect_tick', 'bacnet_autoconnect');
apiGroup.h = (apiGroup.h || 200) + 50;

// ─── 5. Interface ───────────────────────────────────────────────────────────

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `                    { value: 'internal', label: 'Internal simulation' },
                    { value: 'simulated', label: 'Simulated BACnet server' },
                    { value: 'real', label: 'Real BACnet server' }`,
    `                    { value: 'simulated', label: 'Simulated BACnet server' },
                    { value: 'real', label: 'Real BACnet server' },
                    { value: 'disconnected', label: 'Disconnect' }`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `            statusClass() {
                if (this.state.mode === 'internal') return 'is-internal';
                return this.state.driver && this.state.driver.connected ? 'is-live' : 'is-down';
            },
            statusTitle() {
                if (this.state.mode === 'internal') return 'Internal simulation — no network';
                if (!this.state.driver || !this.state.driver.connected) return 'BACnet server not connected';`,
    `            statusClass() {
                if (this.state.mode === 'disconnected') return 'is-internal';
                return this.state.driver && this.state.driver.connected ? 'is-live' : 'is-down';
            },
            statusTitle() {
                if (this.state.mode === 'disconnected') return 'No point source connected';
                if (!this.state.driver || !this.state.driver.connected) return 'BACnet server not connected';`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `                if (this.state.mode === 'internal') {
                    return this.state.pointCount + ' points held in memory, physics running in Node-RED';
                }`,
    `                if (this.state.mode === 'disconnected') {
                    return 'Values are frozen at their last known state. Connect a server below.';
                }`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `                switch (this.state.mode) {
                    case 'internal': return 'Everything stays in memory. No BACnet traffic. This is the default.';
                    case 'simulated': return 'The building simulator runs as a real BACnet/IP device you can browse.';
                    default: return 'Points are read from and written to a real controller.';
                }`,
    `                switch (this.state.mode) {
                    case 'disconnected': return 'No source. Values are frozen — connect the simulator or a controller.';
                    case 'simulated': return 'The building simulator runs as a real BACnet/IP device you can browse.';
                    default: return 'Points are read from and written to a real controller.';
                }`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `            choose(mode) {
                this.feedback = '';
                if (mode === 'internal') return this.connect('internal');`,
    `            choose(mode) {
                this.feedback = '';
                if (mode === 'disconnected') return this.connect('disconnected');`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `                        this.feedback = mode === 'internal'
                            ? 'Back to internal simulation.'
                            : 'Connected — ' + (payload.connectResult ? payload.connectResult.bound : 0) + ' points bound.';`,
    `                        this.feedback = mode === 'disconnected'
                            ? 'Disconnected.'
                            : 'Connected — ' + (payload.connectResult ? payload.connectResult.bound : 0) + ' points bound.';`);

fk.replaceInTemplate(flows, 'bacnet_conn_ui',
    `            <p v-if="state.mode === 'internal'">
                Internal simulation is active: the sliders below drive the in-memory point
                table directly, and the physics runs inside Node-RED.
            </p>
            <p v-else>
                Points now come from a BACnet server, and sensors there are Analog/Binary
                Inputs — not writable, on the simulator as on real hardware. The sliders
                below will report the server's refusal rather than silently pretend. Use
                <em>Internal simulation</em> to drive sensors by hand.
            </p>`,
    `            <p v-if="state.mode === 'simulated'">
                The sliders below drive the simulator's physics engine through its own
                control channel — not over BACnet, where a sensor is a read-only input.
                A forced value becomes an input to the next physics tick and comes back
                as a COV notification, so the building reacts to it.
            </p>
            <p v-else-if="state.mode === 'real'">
                Sensors on a real controller are Analog/Binary Inputs and cannot be forced.
                The sliders below will report the refusal rather than silently pretend.
            </p>
            <p v-else>
                Connect a point source above before using the sliders below.
            </p>`);

const simGroup = flows.find((n) => n.type === 'ui-group'
    && n.page === 'page_simulator' && n.id !== 'grp_ui_bacnet');
if (simGroup) simGroup.name = 'Sensor Simulation (simulated server only)';

for (const name of ['Write', 'API: bacnet', 'Auto-connect BACnet']) {
    new Function('msg', 'node', 'global', 'flow', 'env', 'context', 'RED', 'util', fk.node(flows, name).func);
}

fk.save(flows);
const s = fk.summary(flows);
console.log(`mode « internal » supprimé — ${s.nodes} nœuds`);
console.log('  Physics Simulator et son inject retirés du flow');
console.log('  modes : simulated | real | disconnected');
console.log('  connexion automatique au serveur simulé au démarrage');
