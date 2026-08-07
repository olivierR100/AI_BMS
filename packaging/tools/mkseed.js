#!/usr/bin/env node
/*
 * mkseed.js — produit packaging/seed/global.json à partir du contexte global vivant.
 *
 *   node packaging/tools/mkseed.js [source] [destination]
 *
 * Rôle : extraire la configuration de démonstration (agents, règles, états,
 * widgets) du store de contexte fichier de Node-RED, en retirant tout secret.
 * Les clés d'API des fournisseurs LLM sont remises à vide — elles ne doivent
 * jamais quitter la machine d'origine.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(process.env.HOME, '.node-red/context/global/global.json');
const DST = process.argv[3] || path.join(__dirname, '..', 'seed', 'global.json');

// Seules ces clés sont exportées. Toute autre clé du contexte vivant est
// ignorée : liste blanche, pour qu'une nouvelle clé contenant un secret ne
// se retrouve pas dans l'archive par accident.
const EXPORTED_KEYS = [
    'behaviorAgents',
    'ruleGroups',
    'stateRegistry',
    'dashboardConfig',
    'aiChatSettings',
];

if (!fs.existsSync(SRC)) {
    console.error(`Source introuvable : ${SRC}`);
    process.exit(1);
}

const live = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const seed = {};

for (const key of EXPORTED_KEYS) {
    if (live[key] !== undefined) seed[key] = live[key];
}

// Purge des secrets : clés d'API vidées, historique de conversation écarté.
if (seed.aiChatSettings) {
    const s = seed.aiChatSettings;
    if (s.keys && typeof s.keys === 'object') {
        for (const provider of Object.keys(s.keys)) s.keys[provider] = '';
    }
    delete s.history;
    delete s.transcript;
}

// Garde-fou : rien qui ressemble à une clé d'API ne doit subsister.
const serialised = JSON.stringify(seed);
const SECRET_PATTERNS = [
    /sk-ant-[A-Za-z0-9_-]{20,}/,          // Anthropic
    /sk-[A-Za-z0-9]{32,}/,                // OpenAI / DeepSeek
    /"[A-Za-z0-9]{32,64}"\s*:?\s*$/,      // jeton nu isolé
];
for (const re of SECRET_PATTERNS) {
    const hit = serialised.match(re);
    if (hit) {
        console.error(`ABANDON : secret potentiel détecté dans la graine — ${hit[0].slice(0, 12)}…`);
        process.exit(1);
    }
}

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, JSON.stringify(seed, null, 1));

const summary = EXPORTED_KEYS
    .filter((k) => seed[k] !== undefined)
    .map((k) => `${k}=${Array.isArray(seed[k]) ? seed[k].length : 'obj'}`)
    .join('  ');

console.log(`Graine écrite : ${DST}`);
console.log(`  ${summary}`);
console.log(`  ${(serialised.length / 1024).toFixed(1)} Ko, clés d'API vidées`);
