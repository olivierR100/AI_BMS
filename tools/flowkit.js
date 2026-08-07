'use strict';
/*
 * flowkit — édition programmatique de flows.json.
 *
 * Éditer à la main un flows.json de 258 Ko dont le code vit dans des chaînes
 * JSON échappées est une source d'erreurs. Ce module donne un accès par nom de
 * nœud, vérifie que les remplacements portent bien, et écrit le fichier au
 * format que Node-RED produit lui-même (flowFilePretty).
 *
 * Usage type dans un script de patch :
 *
 *   const fk = require('./tools/flowkit');
 *   const flows = fk.load();
 *   fk.replaceInFunc(flows, 'API: points_get', 'ancien', 'nouveau');
 *   fk.save(flows);
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FLOWS = path.join(REPO, 'flows.json');

function load(file = FLOWS) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(flows, file = FLOWS) {
    validate(flows);
    fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
    return file;
}

/** Contrôles d'intégrité avant écriture — un flows.json cassé coûte cher. */
function validate(flows) {
    if (!Array.isArray(flows)) throw new Error('flows doit être un tableau');

    const ids = new Set();
    for (const n of flows) {
        if (!n.id) throw new Error(`nœud sans id : ${JSON.stringify(n).slice(0, 120)}`);
        if (ids.has(n.id)) throw new Error(`id dupliqué : ${n.id}`);
        ids.add(n.id);
    }

    // Tout fil doit pointer vers un nœud existant.
    for (const n of flows) {
        for (const wires of n.wires || []) {
            for (const target of wires || []) {
                if (!ids.has(target)) {
                    throw new Error(`${n.name || n.id} câblé vers un nœud inexistant : ${target}`);
                }
            }
        }
        for (const key of ['z', 'g', 'page', 'group', 'ui', 'theme']) {
            if (n[key] && typeof n[key] === 'string' && !ids.has(n[key]) && key !== 'z') {
                throw new Error(`${n.name || n.id}.${key} référence un id inconnu : ${n[key]}`);
            }
        }
    }
    return true;
}

function byId(flows, id) {
    const n = flows.find((x) => x.id === id);
    if (!n) throw new Error(`nœud introuvable par id : ${id}`);
    return n;
}

function byName(flows, name) {
    const hits = flows.filter((x) => x.name === name);
    if (hits.length === 0) throw new Error(`nœud introuvable par nom : ${name}`);
    if (hits.length > 1) throw new Error(`nom ambigu (${hits.length} nœuds) : ${name}`);
    return hits[0];
}

/** Accepte un id ou un nom. */
function node(flows, ref) {
    return flows.some((x) => x.id === ref) ? byId(flows, ref) : byName(flows, ref);
}

/**
 * Remplace un fragment dans le code d'un nœud function. Échoue si le fragment
 * est absent ou présent plusieurs fois — un patch qui ne mord pas doit être
 * bruyant, jamais silencieux.
 */
function replaceInFunc(flows, ref, needle, replacement, { count = 1 } = {}) {
    const n = node(flows, ref);
    if (typeof n.func !== 'string') throw new Error(`${ref} n'est pas un nœud function`);
    const occurrences = n.func.split(needle).length - 1;
    if (occurrences !== count) {
        throw new Error(
            `${ref} : fragment attendu ${count} fois, trouvé ${occurrences} fois.\n` +
            `Fragment : ${needle.slice(0, 160)}`,
        );
    }
    n.func = n.func.split(needle).join(replacement);
    return n;
}

/** Idem pour le champ `format` d'un ui-template. */
function replaceInTemplate(flows, ref, needle, replacement, { count = 1 } = {}) {
    const n = node(flows, ref);
    if (typeof n.format !== 'string') throw new Error(`${ref} n'est pas un ui-template`);
    const occurrences = n.format.split(needle).length - 1;
    if (occurrences !== count) {
        throw new Error(`${ref} : fragment attendu ${count} fois, trouvé ${occurrences} fois`);
    }
    n.format = n.format.split(needle).join(replacement);
    return n;
}

function setFunc(flows, ref, code) {
    const n = node(flows, ref);
    n.func = code;
    return n;
}

/** Insère des nœuds, en refusant les collisions d'id. */
function addNodes(flows, nodes) {
    const ids = new Set(flows.map((n) => n.id));
    for (const n of nodes) {
        if (ids.has(n.id)) throw new Error(`id déjà présent : ${n.id}`);
        ids.add(n.id);
        flows.push(n);
    }
    return flows;
}

function removeNodes(flows, ids) {
    const set = new Set(ids);
    for (let i = flows.length - 1; i >= 0; i--) {
        if (set.has(flows[i].id)) flows.splice(i, 1);
    }
    // Nettoie les fils qui pointaient vers les nœuds retirés.
    for (const n of flows) {
        if (!n.wires) continue;
        n.wires = n.wires.map((w) => (w || []).filter((t) => !set.has(t)));
    }
    return flows;
}

function summary(flows) {
    const types = {};
    for (const n of flows) types[n.type] = (types[n.type] || 0) + 1;
    return { nodes: flows.length, types };
}

module.exports = {
    REPO, FLOWS,
    load, save, validate,
    byId, byName, node,
    replaceInFunc, replaceInTemplate, setFunc,
    addNodes, removeNodes, summary,
};
