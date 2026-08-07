'use strict';
/*
 * Patch — retours d'usage sur la page BACnet.
 *
 *  1. Le panneau de connexion occupait une hauteur fixe de 18 rangées, soit
 *     presque un écran de vide sous le contenu. Passage en hauteur automatique.
 *  2. Le panneau « Sensor Simulation » fonctionne désormais RÉELLEMENT dans les
 *     deux modes : en BACnet, ses écritures partent vers le serveur au lieu de
 *     modifier une copie locale que le rafraîchissement écrasait.
 *  3. Le mode Démo/Test rejoint la page Settings : c'est un réglage
 *     d'administration, pas une page à part entière.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─── 1. Hauteur automatique du panneau de connexion ─────────────────────────
// En Dashboard 2.0, height = "0" laisse le widget se dimensionner sur son contenu.
const conn = fk.byId(flows, 'bacnet_conn_ui');
conn.height = '0';
fk.byId(flows, 'grp_ui_bacnet').height = '1';

// ─── 2. Les curseurs capteurs écrivent vers le serveur en mode BACnet ───────

fk.setFunc(flows, 'Write', `// Écriture d'un capteur depuis le panneau « Sensor Simulation ».
//
// En simulation interne, la table en mémoire EST le matériel : on la modifie
// directement. En mode BACnet, la modifier localement ne sert à rien — le
// serveur ne l'apprend pas et la prochaine notification COV écrase la valeur.
// Il faut écrire vers le serveur, qui la reprendra comme donnée d'entrée de
// sa physique.
//
// Un vrai automate refusera : ses capteurs sont des Analog/Binary Input en
// lecture seule. Le refus est alors la bonne réponse, et il est visible.

if (msg.topic !== 'sensor_update') return null;

const { id, value } = msg.payload || {};
if (!id) return null;

const io = global.get('ioDrivers');
const driver = io ? io.driverFor(id) : null;

if (driver && driver.name !== 'simulator') {
    driver.write(id, value)
        .then(res => {
            if (res && res.ok) {
                node.status({ fill: 'green', shape: 'dot', text: id + ' = ' + value });
            } else {
                const why = (res && res.error) || 'refusé';
                node.status({ fill: 'yellow', shape: 'ring', text: id + ' — ' + why });
                node.warn('forçage capteur refusé par le serveur BACnet : ' + why);
            }
        })
        .catch(e => {
            node.status({ fill: 'red', shape: 'ring', text: id + ' — ' + e.message });
        });
    return null;
}

const bacnet = global.get('bacnetPoints');
if (bacnet && bacnet[id]) {
    bacnet[id].value = value;
    global.set('bacnetPoints', bacnet);
    node.status({ fill: 'green', shape: 'dot', text: id + ' = ' + value });
}
return null;
`);

// Le titre disait « internal mode only » : ce n'est plus vrai.
const simGroup = flows.find((n) => n.type === 'ui-group'
    && n.page === 'page_simulator' && n.id !== 'grp_ui_bacnet');
if (simGroup) simGroup.name = 'Sensor Simulation';

// Et le texte explicatif du panneau de connexion doit dire la même chose.
fk.replaceInTemplate(flows, 'bacnet_conn_ui',
`            <p v-if="state.mode === 'internal'">
                Internal simulation is active: the sliders below drive the in-memory point
                table directly, and the physics runs inside Node-RED.
            </p>
            <p v-else>
                Points now come from a BACnet server over the network, and its own physics
                owns the sensors. The sliders below only affect the internal simulation, so
                they have no effect in this mode — just as you could not move a real sensor
                by dragging a slider. Switch back to <em>Internal simulation</em> to use them.
            </p>`,
`            <p v-if="state.mode === 'internal'">
                Internal simulation is active: the sliders below drive the in-memory point
                table directly, and the physics runs inside Node-RED.
            </p>
            <p v-else-if="state.mode === 'simulated'">
                The sliders below now write to the simulated BACnet server, which takes the
                forced value as an input to its next physics tick — so a forced temperature
                is pulled back towards setpoint exactly as it is in internal mode.
            </p>
            <p v-else>
                The sliders below write to the real controller. It will almost certainly
                refuse: sensors are Analog/Binary Inputs and are not writable over BACnet.
                The refusal is reported rather than silently ignored.
            </p>`);

// ─── 3. Le mode Démo/Test rejoint Settings ──────────────────────────────────

const demoGroup = fk.byId(flows, 'grp_ui_demo_mode');
demoGroup.page = 'page_settings';
demoGroup.name = 'Demo / Test Mode — time speed';
demoGroup.order = 2;
fk.byId(flows, 'demo_test_ui').height = '0';

fk.removeNodes(flows, ['page_demo_test']);

// La page Settings devient la page d'administration : elle mérite son nom.
const settings = fk.byId(flows, 'page_settings');
settings.name = 'Settings';
settings.icon = 'mdi-cog';

for (const name of ['Write']) {
    const n = fk.node(flows, name);
    new Function('msg', 'node', 'global', 'flow', 'env', 'context', 'RED', 'util', n.func);
}

fk.save(flows);
console.log('retours appliqués —', fk.summary(flows).nodes, 'nœuds');
console.log('  panneau BACnet : hauteur automatique');
console.log('  capteurs : écriture vers le serveur en mode BACnet');
console.log('  Démo/Test : déplacé dans Settings, page dédiée supprimée');
