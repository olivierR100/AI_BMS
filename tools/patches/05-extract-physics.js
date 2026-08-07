'use strict';
/*
 * Patch — extraction du moteur physique hors du flow.
 *
 * La physique appartient au bâtiment simulé, pas au système de gestion. En la
 * sortant, elle peut alimenter le serveur BACnet de test — qui devient un vrai
 * équipement sur le réseau — au lieu de muter une table en mémoire partagée
 * avec le BMS.
 *
 * Découpage verbatim des lignes 13..201 (le corps de calcul), les bornes
 * — lecture du contexte global et affichage du statut — étant remplacées par
 * des paramètres et une valeur de retour.
 */

const fs = require('node:fs');
const path = require('node:path');
const fk = require('../flowkit');

const flows = fk.load();
const phys = fk.node(flows, 'Physics Simulator');
const lines = phys.func.split('\n');

if (lines.length !== 211) {
    throw new Error(`Physics Simulator : ${lines.length} lignes au lieu de 211 — bornes à revérifier`);
}
const expect = (n, frag) => {
    if (!lines[n - 1].includes(frag)) throw new Error(`ligne ${n} attendue « ${frag} », trouvée « ${lines[n - 1]} »`);
};
expect(10, "const bacnetPoints = global.get('bacnetPoints')");
expect(13, 'Get outside conditions');
expect(200, "global.set('bacnetPoints', bacnetPoints)");
expect(204, 'const tempInfo');

const body = lines.slice(12, 196).join('\n');   // 13..196 : le calcul, sans le global.set final

const SIM_DIR = path.join(fk.REPO, 'lib', 'bacnet-sim');
fs.mkdirSync(SIM_DIR, { recursive: true });

const module_ = `'use strict';
/*
 * Moteur physique du bâtiment simulé.
 *
 * Extrait verbatim du nœud « Physics Simulator » du flow. Les zones sont
 * découvertes dynamiquement depuis les étiquettes de bmsMetadata : ajouter un
 * point correctement étiqueté suffit à l'intégrer à la simulation.
 *
 * Mute \`bacnetPoints\` en place et rend un résumé du tick.
 */

/**
 * @param {object} bacnetPoints  table des points (mutée)
 * @param {object} bmsMetadata   étiquettes et zones
 * @returns {{changes:number, zoneCount:number, outsideTemp:number}}
 */
function runPhysicsTick(bacnetPoints, bmsMetadata) {
${body}

    return { changes, zoneCount, outsideTemp };
}

module.exports = { runPhysicsTick };
`;

try {
    new Function('module', 'exports', module_);
} catch (e) {
    throw new Error(`physics.js invalide après extraction : ${e.message}`);
}
fs.writeFileSync(path.join(SIM_DIR, 'physics.js'), module_);

// Le nœud du flow délègue au module. Il reste en place pour le mode « interne »
// (simulation en mémoire, sans BACnet) : c'est le mode par défaut, celui des
// tests et de la démonstration hors réseau.
phys.func = `// Physique du bâtiment simulé.
//
// Le calcul vit dans lib/bacnet-sim/physics.js — partagé avec le serveur BACnet
// de test, pour qu'il n'existe qu'un seul modèle physique.
//
// Ce nœud ne s'exécute qu'en mode « internal » (simulation en mémoire). En mode
// BACnet, la physique tourne dans le serveur BACnet et les valeurs arrivent par
// COV : la faire tourner ici aussi ferait deux simulateurs concurrents.

const virtualPoints = global.get('virtualPoints') || {};
if (virtualPoints['physics_enabled']?.value !== true) {
    node.status({ fill: 'grey', shape: 'ring', text: 'Disabled' });
    return null;
}

if ((global.get('bacnetMode') || 'internal') !== 'internal') {
    node.status({ fill: 'blue', shape: 'ring', text: 'BACnet mode — physique côté serveur' });
    return null;
}

const core = global.get('bmsCore');
if (!core || !core.runPhysicsTick) {
    node.status({ fill: 'red', shape: 'ring', text: 'physics module absent' });
    return null;
}

const bacnetPoints = global.get('bacnetPoints') || {};
const bmsMetadata = global.get('bmsMetadata') || {};
const { changes, zoneCount, outsideTemp } = core.runPhysicsTick(bacnetPoints, bmsMetadata);

if (changes > 0) global.set('bacnetPoints', bacnetPoints);

node.status({
    fill: changes > 0 ? 'green' : 'grey',
    shape: 'dot',
    text: changes + ' updates | ' + zoneCount + ' zones | ' + outsideTemp.toFixed(1) + '°C out'
});

return null;
`;

try {
    new Function('msg', 'node', 'global', 'flow', 'env', 'context', 'RED', 'util', phys.func);
} catch (e) {
    throw new Error(`nœud Physics Simulator invalide : ${e.message}`);
}

fk.save(flows);
console.log(`physics.js écrit (${body.split('\n').length} lignes de calcul)`);
console.log(`nœud Physics Simulator : 211 → ${phys.func.split('\n').length} lignes`);
