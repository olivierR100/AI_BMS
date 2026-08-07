'use strict';
/*
 * Patch — extraction du cœur BMS hors du nœud function.
 *
 * « Initialize System (V12) » pesait 75 000 caractères dans une chaîne JSON :
 * illisible en revue, indiffable, intestable unitairement, et c'est là que
 * atterrit tout le travail BACnet à venir.
 *
 * Méthode : découpage VERBATIM. Chaque bloc est déplacé tel quel dans un module
 * qui reçoit le contexte du nœud ({ global, node, env }). Aucune ligne n'est
 * réécrite, donc le comportement ne peut pas dériver — c'est le point : le
 * harnais de test doit rester vert sans la moindre retouche.
 *
 * Les modules sont chargés par settings.js via functionGlobalContext.bmsCore.
 */

const fs = require('node:fs');
const path = require('node:path');
const fk = require('../flowkit');

const flows = fk.load();
const init = fk.node(flows, 'Initialize System (V12)');
const lines = init.func.split('\n');

if (init.func.includes("global.get('bmsCore')")) {
    throw new Error('extraction déjà appliquée');
}
if (lines.length !== 1311) {
    throw new Error(
        `nombre de lignes inattendu : ${lines.length} au lieu de 1311. ` +
        `Les bornes de découpage ne sont plus valides — revérifiez-les avant de rejouer ce patch.`,
    );
}

/** Lignes 1-indexées, bornes incluses. */
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

// Vérifie qu'une borne tombe bien où on le croit.
const expect = (lineNo, fragment) => {
    if (!lines[lineNo - 1].includes(fragment)) {
        throw new Error(`ligne ${lineNo} attendue « ${fragment} », trouvée « ${lines[lineNo - 1]} »`);
    }
};

expect(1, "const SunCalc = global.get('suncalcModule')");
expect(267, "global.set('virtualPoints', virtualPoints)");
expect(272, 'const BMS = {');
expect(492, 'Demo/Test mode actif au démarrage');
expect(494, 'Restore AI configuration');
expect(545, "global.set('aiChatTools'");
expect(572, '}]);');
expect(580, "global.set('aiProviders'");
expect(707, '});');
expect(709, 'API call log');
expect(767, "global.set('buildAIPrompt', function(mode)");
expect(1301, '});');
expect(1311, 'return msg;');

const MODULE_DIR = path.join(fk.REPO, 'lib', 'bms-core');
fs.mkdirSync(MODULE_DIR, { recursive: true });

const header = (title, why) => `'use strict';
/*
 * ${title}
 *
 * ${why}
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : \`global\` (contexte global), \`node\` (statut et
 * journal), \`env\` (variables d'environnement).
 */

`;

const chunks = [
    {
        file: 'points.js',
        title: 'Tables de points — la couche matérielle simulée et ses métadonnées',
        why: 'bacnetPoints porte le matériel (valeur, unité, accès, bornes), bmsMetadata\n * porte la vue GTB (étiquettes, zone). Cette séparation est la couture prévue\n * pour brancher un vrai réseau BACnet : ne pas la fusionner.',
        body: slice(1, 267),
        exportName: 'installPoints',
        returns: '    return { bacnetPoints, bmsMetadata, virtualPoints };',
    },
    {
        file: 'bms.js',
        title: 'Abstraction BMS — le point de passage unique vers les points',
        why: 'Tout accès à un point et toute application de configuration passent par cet\n * objet. C\'est la couture que la future couche pilote (BACnet) remplacera.',
        body: slice(269, 492),
        exportName: 'installBms',
    },
    {
        file: 'restore.js',
        title: 'Restauration de la configuration persistée',
        why: 'Agents, règles, états, widgets et réglages IA vivent dans le magasin de\n * contexte « file » et sont relus au démarrage.',
        body: slice(494, 539),
        exportName: 'installRestore',
    },
    {
        file: 'tools.js',
        title: 'Définitions d\'outils pour l\'assistant IA embarqué',
        why: 'read_config et apply_bms_config : le contrat que le modèle voit.',
        body: slice(541, 572),
        exportName: 'installTools',
    },
    {
        file: 'providers.js',
        title: 'Couche d\'adaptation multi-fournisseurs (Anthropic / OpenAI / DeepSeek / Mistral)',
        why: 'Historique interne neutre, traduit par fournisseur au moment de la requête.',
        body: slice(574, 707),
        exportName: 'installProviders',
    },
    {
        file: 'logging.js',
        title: 'Journal des appels API pour le moniteur du dashboard',
        why: 'Tampon circulaire structuré. Les clés d\'API ne sont jamais journalisées.',
        body: slice(709, 764),
        exportName: 'installLogging',
    },
    {
        file: 'prompt.js',
        title: 'Constructeur de prompt partagé',
        why: 'Mode « paste » pour la page AI Configuration, mode « tool » pour l\'assistant\n * embarqué. Les règles d\'alignement conversationnel qu\'il contient ne doivent\n * jamais être retirées (cf. CLAUDE.md).',
        body: slice(766, 1301),
        exportName: 'installPrompt',
    },
];

for (const chunk of chunks) {
    const source =
        header(chunk.title, chunk.why) +
        `module.exports = function ${chunk.exportName}(ctx) {\n` +
        `    const { global, node, env } = ctx;\n\n` +
        chunk.body + '\n' +
        (chunk.returns ? '\n' + chunk.returns + '\n' : '') +
        `};\n`;

    // Contrôle de syntaxe avant écriture : un module cassé ne doit jamais
    // atteindre le disque.
    try {
        new Function('module', 'exports', 'require', source);
    } catch (e) {
        throw new Error(`${chunk.file} : syntaxe invalide après extraction — ${e.message}`);
    }
    fs.writeFileSync(path.join(MODULE_DIR, chunk.file), source);
    console.log(`  ${chunk.file.padEnd(14)} ${chunk.body.split('\n').length.toString().padStart(4)} lignes`);
}

// index.js
fs.writeFileSync(path.join(MODULE_DIR, 'index.js'), `'use strict';
/*
 * bms-core — le cœur du BMS, hors du nœud function.
 *
 * Chargé par settings.js dans functionGlobalContext sous la clé \`bmsCore\`, et
 * consommé par « Initialize System (V12) », qui n'est plus qu'un amorçage.
 *
 * Conséquence à connaître : ces fichiers sont lus au DÉMARRAGE de Node-RED.
 * Les modifier demande un redémarrage, pas un simple déploiement.
 *
 * L'ordre d'installation compte : les tables de points d'abord (les autres
 * modules les lisent dans le contexte global), l'abstraction BMS ensuite.
 */

module.exports = {
    installPoints:    require('./points'),
    installBms:       require('./bms'),
    installRestore:   require('./restore'),
    installTools:     require('./tools'),
    installProviders: require('./providers'),
    installLogging:   require('./logging'),
    installPrompt:    require('./prompt'),

    /** Séquence complète d'amorçage. Renvoie les tables de points. */
    installAll(ctx) {
        const tables = this.installPoints(ctx);
        this.installBms(ctx);
        this.installRestore(ctx);
        this.installTools(ctx);
        this.installProviders(ctx);
        this.installLogging(ctx);
        this.installPrompt(ctx);
        return tables;
    },
};
`);

fs.writeFileSync(path.join(MODULE_DIR, 'package.json'), JSON.stringify({
    name: 'bms-core',
    version: '1.0.0',
    private: true,
    description: 'Cœur du AI BMS : tables de points, abstraction BMS, application de configuration, prompt IA.',
    main: 'index.js',
}, null, 2) + '\n');

// ─────────────────────────────────────────────────────────────────────────────
// Le nœud devient un amorçage.
// ─────────────────────────────────────────────────────────────────────────────

init.func = `// Amorçage. Le cœur du BMS vit dans lib/bms-core/ et est chargé par
// settings.js (functionGlobalContext.bmsCore) — code éditable, diffable et
// testable, au lieu de 75 000 caractères dans une chaîne JSON.
//
// À savoir : les modules sont lus au démarrage de Node-RED. Après une
// modification de lib/bms-core/, redéployer ne suffit pas — il faut redémarrer.

const core = global.get('bmsCore');
if (!core) {
    const hint = "bmsCore introuvable. Ajoutez  bmsCore: require('./lib/bms-core')  "
               + "dans functionGlobalContext de settings.js, copiez lib/ dans le userDir, "
               + "puis redémarrez Node-RED.";
    node.error(hint);
    node.status({ fill: 'red', shape: 'ring', text: 'bmsCore manquant' });
    return null;
}

const { bacnetPoints, virtualPoints } = core.installAll({ global, node, env });

${slice(1303, 1309)}

return msg;
`;

try {
    new Function('msg', 'node', 'global', 'flow', 'env', 'context', 'RED', 'util', init.func);
} catch (e) {
    throw new Error(`nœud d'amorçage invalide : ${e.message}`);
}

fk.save(flows);

console.log(`\nInitialize System : 75169 → ${init.func.length} caractères`);
console.log(`lib/bms-core/ : ${fs.readdirSync(MODULE_DIR).length} fichiers`);
