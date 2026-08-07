'use strict';
/*
 * Taxonomie des étiquettes — un TYPE sur chaque étiquette, et la zone comme
 * première classe.
 *
 * ─── Le problème ────────────────────────────────────────────────────────────
 *
 * Les étiquettes mélangeaient quatre natures : des étages (`floor1`), des types
 * de local (`lobby`, `meeting`), des rôles (`sensor`, `actuator`) et des
 * fonctions (`temperature`, `co2`). Les deux premières faisaient doublon avec la
 * zone, qui portait déjà tout le travail de regroupement — mais la zone était
 * codée en dur dans `points.js`, invisible et non modifiable.
 *
 * ─── La cible ───────────────────────────────────────────────────────────────
 *
 *   { tag: 'F1_Meeting',  type: 'zone' }      exactement UNE par point
 *   { tag: 'temperature', type: 'function' }  plusieurs possibles
 *   { tag: 'sensor',      type: 'role' }
 *   { tag: 'booking',     type: 'other' }
 *
 * Les **groupes de zones** remplacent les étages et les types de local. Un
 * groupe rassemble des zones ET d'autres groupes, ce qui donne la hiérarchie
 * attendue : « Bâtiment » regroupe les étages, un étage regroupe ses zones, et
 * « Façade sud » peut traverser les étages. La détection de cycle est faite à
 * l'écriture.
 *
 * ─── La couture avec l'existant ─────────────────────────────────────────────
 *
 * La source de vérité devient l'étiquette de type `zone`. `bmsMetadata[id].zone`
 * reste un champ **DÉRIVÉ**, recalculé à chaque modification. Le moteur physique
 * (`bacnet-sim/physics.js`) et l'analyseur (`analyse.js`) continuent donc de lire
 * `meta.zone` sans le savoir : chemin chaud inchangé, un seul endroit où la
 * vérité s'écrit.
 *
 * Les étiquettes de rôle et de fonction sont **porteuses** : la physique
 * catégorise sur `sensor`+`temperature`, `actuator`+`lighting`, etc., et
 * `control_group` les développe en points. Elles ne bougent pas. Seuls les
 * étages et les types de local sont redondants, et deviennent des groupes.
 */

const TAG_TYPES = ['zone', 'function', 'role', 'other'];

/** Proposées avant saisie libre — la liste n'est pas fermée. */
const PREDEFINED = {
    function: ['temperature', 'humidity', 'co2', 'iaq', 'motion', 'occupancy', 'light',
               'lighting', 'hvac_temp', 'hvac_vent', 'setpoint', 'ventilation'],
    role: ['sensor', 'actuator'],
};

/*
 * Étiquettes du parc de démonstration qui font doublon avec la zone. La
 * migration les convertit en groupes de zones — l'information de regroupement
 * est conservée, la redondance disparaît.
 *
 * Vérifié avant de le faire : aucune règle de la configuration vivante ne cite
 * l'une de ces étiquettes (seules `lighting` et `hvac_temp` sont citées, et ce
 * sont des fonctions). La conversion ne casse donc aucune règle.
 */
const REDUNDANT_TO_GROUP = {
    floor1: 'Floor 1', floor2: 'Floor 2', floor3: 'Floor 3',
    global: 'Outside',
    lobby: 'Lobbies', corridor: 'Corridors', meeting: 'Meeting rooms',
    office: 'Offices', storage: 'Storage rooms',
};

/** Groupes de groupes créés à la migration, pour que la hiérarchie existe. */
const GROUPS_OF_GROUPS = {
    Building: ['Floor 1', 'Floor 2', 'Floor 3'],
};

const TAG_RE = /^[A-Za-z0-9_.:-]+$/;

/**
 * Une étiquette est un IDENTIFIANT : les règles la citent (`control_group`), le
 * prompt la liste, la physique la teste. D'où le jeu de caractères restreint et
 * les espaces transformés en soulignés. Les majuscules sont conservées — les
 * zones s'appellent `F1_Lobby`.
 */
function normaliseTag(raw) {
    const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, '_');
    if (!t) throw new Error('nom d’étiquette vide');
    if (!TAG_RE.test(t)) throw new Error(`nom d’étiquette invalide : « ${raw} » ` +
        `(lettres, chiffres, _ . : - ; les espaces deviennent des soulignés)`);
    return t;
}

/**
 * Un groupe de zones est un LIBELLÉ, pas un identifiant : il ne sert qu'à
 * filtrer et à s'afficher, aucune règle ne le cite. « Façade sud » et
 * « Étage 1 » doivent donc rester lisibles, accents et espaces compris.
 */
function normaliseGroupName(raw) {
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('nom de groupe vide');
    if (t.length > 60) throw new Error('nom de groupe trop long (60 caractères maximum)');
    // Seuls les caractères de contrôle sont refusés : ils casseraient l’affichage
    // sans jamais être ce que quelqu’un a voulu taper.
    if (/[\x00-\x1f]/.test(t)) throw new Error('nom de groupe invalide (caractère de contrôle)');
    return t;
}

/** Classement d'une étiquette inconnue, pour la migration et la réconciliation. */
function classify(tag, zoneNames) {
    if (zoneNames.has(tag)) return 'zone';
    if (PREDEFINED.role.includes(tag)) return 'role';
    if (PREDEFINED.function.includes(tag)) return 'function';
    return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Groupes : expansion et cycles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zones atteintes par un groupe, en descendant la hiérarchie.
 * Rend aussi les groupes traversés — utile pour expliquer un filtre.
 */
function expand(groups, name) {
    const zones = new Set(), visited = new Set();
    (function walk(g) {
        if (visited.has(g)) return;   // cycle impossible par construction, mais gratuit
        visited.add(g);
        const def = groups[g];
        if (!def) return;
        for (const m of def.members || []) {
            if (groups[m]) walk(m);
            else zones.add(m);
        }
    })(name);
    return { zones: [...zones], groups: [...visited] };
}

/**
 * Un groupe ne doit pas se contenir, même indirectement. On teste l'appartenance
 * AVANT d'écrire : un cycle rendrait tout parcours infini, et le diagnostic
 * arriverait bien plus tard, dans un filtre qui ne répond plus.
 */
function wouldCycle(groups, name, members) {
    const candidate = { ...groups, [name]: { members } };
    const state = new Map();   // 0 = en cours, 1 = terminé
    let cycle = null;
    (function visit(g, path) {
        if (state.get(g) === 1) return;
        if (state.get(g) === 0) { cycle = [...path, g]; return; }
        state.set(g, 0);
        for (const m of (candidate[g] && candidate[g].members) || []) {
            if (candidate[m]) visit(m, [...path, g]);
            if (cycle) return;
        }
        state.set(g, 1);
    })(name, []);
    return cycle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Installation
// ─────────────────────────────────────────────────────────────────────────────

const KEYS = ['tagRegistry', 'zoneGroups'];

module.exports = function installTags(ctx) {
    const { global, node } = ctx;

    for (const k of KEYS) {
        if (global.get(k) === undefined || global.get(k) === null) {
            let v;
            try { v = global.get(k, 'file'); } catch (e) { /* magasin file non configuré */ }
            if (v !== undefined && v !== null) global.set(k, v);
        }
    }

    const meta = () => global.get('bmsMetadata') || {};
    const points = () => global.get('bacnetPoints') || {};

    function persist() {
        for (const k of KEYS.concat(['bmsMetadata'])) {
            const v = global.get(k);
            global.set(k, v);
            try { global.set(k, v, 'file'); } catch (e) { /* magasin file non configuré */ }
        }
    }

    /**
     * Recalcule `bmsMetadata[id].zone` depuis l'étiquette de type `zone`.
     * C'est le seul endroit qui écrit ce champ — tout le reste le lit.
     */
    function deriveZones() {
        const reg = global.get('tagRegistry') || {};
        const m = meta();
        let changed = 0;
        for (const [id, entry] of Object.entries(m)) {
            const zoneTag = (entry.tags || []).find((t) => reg[t] && reg[t].type === 'zone');
            const next = zoneTag || '';
            if (entry.zone !== next) { entry.zone = next; changed++; }
        }
        if (changed) global.set('bmsMetadata', m);
        return changed;
    }

    // ─── migration / réconciliation ──────────────────────────────────────────

    /**
     * Première installation : construit le registre depuis les littéraux de
     * `points.js`, convertit les étiquettes redondantes en groupes, et laisse le
     * parc dans l'état cible. Idempotente : une seconde exécution ne trouve plus
     * rien à faire.
     */
    function migrate() {
        const m = meta();
        const report = { zonesCreated: [], typed: {}, groupsCreated: [], tagsRemoved: [], pointsRezoned: 0 };

        const zoneNames = new Set();
        for (const entry of Object.values(m)) if (entry.zone) zoneNames.add(entry.zone);

        const reg = global.get('tagRegistry') || {};
        const groups = global.get('zoneGroups') || {};

        // 1. Une étiquette de type zone par valeur de zone existante, posée sur
        //    les points concernés : la zone devient une étiquette comme une autre.
        for (const zone of zoneNames) {
            if (!reg[zone]) { reg[zone] = { type: 'zone' }; report.zonesCreated.push(zone); }
        }
        for (const [, entry] of Object.entries(m)) {
            if (!entry.zone) continue;
            entry.tags = entry.tags || [];
            if (!entry.tags.includes(entry.zone)) { entry.tags.push(entry.zone); report.pointsRezoned++; }
        }

        // 2. Classer tout ce qui traîne.
        for (const entry of Object.values(m)) {
            for (const t of entry.tags || []) {
                if (reg[t]) continue;
                const type = classify(t, zoneNames);
                reg[t] = { type };
                (report.typed[type] = report.typed[type] || []).push(t);
            }
        }

        // 3. Étages et types de local → groupes de zones. L'information de
        //    regroupement survit, la redondance avec la zone disparaît.
        for (const [tag, groupName] of Object.entries(REDUNDANT_TO_GROUP)) {
            const members = new Set();
            for (const entry of Object.values(m)) {
                if ((entry.tags || []).includes(tag) && entry.zone) members.add(entry.zone);
            }
            if (!members.size) continue;
            if (!groups[groupName]) {
                groups[groupName] = { members: [...members].sort(), derivedFrom: tag };
                report.groupsCreated.push(groupName);
            }
            for (const entry of Object.values(m)) {
                const i = (entry.tags || []).indexOf(tag);
                if (i >= 0) entry.tags.splice(i, 1);
            }
            if (reg[tag]) { delete reg[tag]; report.tagsRemoved.push(tag); }
        }

        // 4. La hiérarchie : un groupe de groupes, pour que « Bâtiment » existe.
        for (const [name, members] of Object.entries(GROUPS_OF_GROUPS)) {
            const present = members.filter((x) => groups[x]);
            if (present.length && !groups[name]) {
                groups[name] = { members: present };
                report.groupsCreated.push(name);
            }
        }

        for (const entry of Object.values(m)) if (entry.tags) entry.tags.sort();

        global.set('tagRegistry', reg);
        global.set('zoneGroups', groups);
        global.set('bmsMetadata', m);
        deriveZones();
        persist();
        return report;
    }

    /**
     * Registre déjà présent : combler les trous plutôt que tout refaire. Un point
     * ajouté depuis, ou une étiquette posée à la main, doit être classé.
     */
    function reconcile() {
        const reg = global.get('tagRegistry') || {};
        const m = meta();
        const zoneNames = new Set(Object.keys(reg).filter((t) => reg[t].type === 'zone'));
        for (const entry of Object.values(m)) if (entry.zone) zoneNames.add(entry.zone);

        const added = [];
        for (const [, entry] of Object.entries(m)) {
            // Un point qui porte encore une zone dérivée mais plus d'étiquette de
            // zone : la lui rendre, sinon la migration l'aurait orphelin.
            if (entry.zone && !(entry.tags || []).some((t) => reg[t] && reg[t].type === 'zone')) {
                if (!reg[entry.zone]) reg[entry.zone] = { type: 'zone' };
                entry.tags = entry.tags || [];
                if (!entry.tags.includes(entry.zone)) entry.tags.push(entry.zone);
            }
            for (const t of entry.tags || []) {
                if (!reg[t]) { reg[t] = { type: classify(t, zoneNames) }; added.push(t); }
            }
        }
        global.set('tagRegistry', reg);
        global.set('bmsMetadata', m);
        const rederived = deriveZones();
        if (added.length || rederived) persist();
        return { added, rederived };
    }

    const firstRun = !global.get('tagRegistry');
    const migration = firstRun ? migrate() : reconcile();

    // ─── contrat ─────────────────────────────────────────────────────────────

    const policy = {
        TAG_TYPES, PREDEFINED,

        registry() { return global.get('tagRegistry') || {}; },
        groups() { return global.get('zoneGroups') || {}; },
        migrationReport() { return migration; },

        typeOf(tag) { const r = this.registry()[tag]; return r ? r.type : null; },
        zones() { return Object.keys(this.registry()).filter((t) => this.typeOf(t) === 'zone').sort(); },
        byType(type) { return Object.keys(this.registry()).filter((t) => this.typeOf(t) === type).sort(); },

        /** Combien de points portent cette étiquette. */
        useCount(tag) {
            return Object.values(meta()).filter((e) => (e.tags || []).includes(tag)).length;
        },

        zoneOf(pointId) {
            const e = meta()[pointId];
            return e ? (e.zone || null) : null;
        },

        /** Le filtre du Device Manager, trié par nature. */
        inventory() {
            const reg = this.registry();
            const out = { zone: [], function: [], role: [], other: [], group: [] };
            for (const [tag, def] of Object.entries(reg)) {
                out[def.type].push({ tag, count: this.useCount(tag),
                                     predefined: (PREDEFINED[def.type] || []).includes(tag) });
            }
            for (const [name, def] of Object.entries(this.groups())) {
                const e = expand(this.groups(), name);
                out.group.push({ tag: name, members: def.members || [], zones: e.zones,
                                 count: this.pointsIn(name).length, derivedFrom: def.derivedFrom || null });
            }
            for (const k of Object.keys(out)) out[k].sort((a, b) => a.tag.localeCompare(b.tag));
            return out;
        },

        /** Points d'une zone ou d'un groupe — un groupe filtre comme une zone. */
        pointsIn(selector) {
            const groups = this.groups();
            const zones = groups[selector] ? new Set(expand(groups, selector).zones) : new Set([selector]);
            return Object.entries(meta())
                .filter(([, e]) => zones.has(e.zone))
                .map(([id]) => id);
        },

        expandGroup(name) {
            if (!this.groups()[name]) throw new Error('groupe inconnu : ' + name);
            return expand(this.groups(), name);
        },

        // ─── étiquettes ──────────────────────────────────────────────────────

        createTag(rawTag, type) {
            const tag = normaliseTag(rawTag);
            if (!TAG_TYPES.includes(type)) throw new Error(`type inconnu : ${type} (attendu ${TAG_TYPES.join('|')})`);
            const reg = this.registry();
            if (reg[tag]) throw new Error(`l’étiquette « ${tag} » existe déjà (type ${reg[tag].type})`);
            if (this.groups()[tag]) throw new Error(`« ${tag} » est déjà un groupe de zones`);
            reg[tag] = { type };
            global.set('tagRegistry', reg);
            persist();
            return { tag, type };
        },

        /**
         * Supprimer une étiquette la retire aussi des points. Pour une zone,
         * c'est refusé tant qu'elle est portée : les points deviendraient sans
         * zone, et la physique les perdrait sans rien dire.
         */
        deleteTag(tag, { force = false } = {}) {
            const reg = this.registry();
            if (!reg[tag]) throw new Error('étiquette inconnue : ' + tag);
            const used = this.useCount(tag);
            if (reg[tag].type === 'zone' && used > 0 && !force) {
                throw new Error(`« ${tag} » est la zone de ${used} point(s) : les déplacer d’abord, ` +
                                `ou forcer explicitement (ils se retrouveraient sans zone, ` +
                                `et le moteur physique ne les grouperait plus)`);
            }
            const m = meta();
            for (const entry of Object.values(m)) {
                const i = (entry.tags || []).indexOf(tag);
                if (i >= 0) entry.tags.splice(i, 1);
            }
            delete reg[tag];
            global.set('tagRegistry', reg);
            global.set('bmsMetadata', m);
            dropCovAssignments(tag);
            const groups = this.groups();
            for (const def of Object.values(groups)) {
                def.members = (def.members || []).filter((x) => x !== tag);
            }
            global.set('zoneGroups', groups);
            deriveZones();
            persist();
            return { deleted: tag, removedFrom: used };
        },

        retypeTag(tag, type) {
            const reg = this.registry();
            if (!reg[tag]) throw new Error('étiquette inconnue : ' + tag);
            if (!TAG_TYPES.includes(type)) throw new Error('type inconnu : ' + type);
            if (type === 'zone') {
                // Devenir une zone est contraignant : un point ne peut en porter
                // qu'une, et certains en porteraient deux d'un coup.
                const conflicts = Object.entries(meta())
                    .filter(([, e]) => (e.tags || []).includes(tag))
                    .filter(([, e]) => (e.tags || []).some((t) => t !== tag && reg[t] && reg[t].type === 'zone'))
                    .map(([id]) => id);
                if (conflicts.length) {
                    throw new Error(`${conflicts.length} point(s) porteraient deux zones ` +
                                    `(${conflicts.slice(0, 3).join(', ')}…) : retirer l’autre zone d’abord`);
                }
            }
            reg[tag].type = type;
            global.set('tagRegistry', reg);
            deriveZones();
            persist();
            return { tag, type };
        },

        /**
         * Renommer suit l'étiquette PARTOUT : points, membres de groupes, et
         * affectations de profils COV. Une affectation laissée derrière serait un
         * réglage fantôme — exactement ce qu'on ne diagnostique jamais.
         */
        renameTag(from, rawTo) {
            const to = normaliseTag(rawTo);
            const reg = this.registry();
            if (!reg[from]) throw new Error('étiquette inconnue : ' + from);
            if (reg[to]) throw new Error(`« ${to} » existe déjà`);
            if (this.groups()[to]) throw new Error(`« ${to} » est déjà un groupe de zones`);

            reg[to] = reg[from];
            delete reg[from];
            global.set('tagRegistry', reg);

            const m = meta();
            let moved = 0;
            for (const entry of Object.values(m)) {
                const i = (entry.tags || []).indexOf(from);
                if (i >= 0) { entry.tags[i] = to; entry.tags.sort(); moved++; }
            }
            global.set('bmsMetadata', m);

            const groups = this.groups();
            let inGroups = 0;
            for (const def of Object.values(groups)) {
                def.members = (def.members || []).map((x) => {
                    if (x !== from) return x;
                    inGroups++;
                    return to;
                });
            }
            global.set('zoneGroups', groups);

            const covMoved = renameCovAssignments(from, to);
            deriveZones();
            persist();
            return { from, to, points: moved, groups: inGroups, covAssignments: covMoved };
        },

        /**
         * Affecter une étiquette. Une zone REMPLACE la précédente : un capteur
         * n'est pas dans deux locaux, et la contrainte est tenue ici plutôt que
         * seulement dans l'interface — l'API ne doit pas pouvoir produire un état
         * que l'interface interdit.
         */
        assignTag(pointId, rawTag) {
            const tag = normaliseTag(rawTag);
            const m = meta();
            if (!points()[pointId] && !m[pointId]) throw new Error('point inconnu : ' + pointId);
            const reg = this.registry();
            if (!reg[tag]) throw new Error(`étiquette inconnue : ${tag} — la créer d’abord, avec son type`);

            const entry = m[pointId] || (m[pointId] = { tags: [], zone: '' });
            entry.tags = entry.tags || [];
            let replaced = null;

            if (reg[tag].type === 'zone') {
                const previous = entry.tags.filter((t) => reg[t] && reg[t].type === 'zone' && t !== tag);
                if (previous.length) {
                    entry.tags = entry.tags.filter((t) => !previous.includes(t));
                    replaced = previous;
                }
            }
            if (!entry.tags.includes(tag)) entry.tags.push(tag);
            entry.tags.sort();
            global.set('bmsMetadata', m);
            deriveZones();
            persist();
            return { pointId, tag, type: reg[tag].type, replaced, zone: this.zoneOf(pointId) };
        },

        unassignTag(pointId, tag) {
            const m = meta();
            const entry = m[pointId];
            if (!entry) throw new Error('point inconnu : ' + pointId);
            const i = (entry.tags || []).indexOf(tag);
            if (i < 0) return { pointId, tag, removed: false, zone: this.zoneOf(pointId) };
            entry.tags.splice(i, 1);
            global.set('bmsMetadata', m);
            deriveZones();
            persist();
            return { pointId, tag, removed: true, zone: this.zoneOf(pointId) };
        },

        /** Raccourci lisible : poser (ou retirer avec `null`) la zone d'un point. */
        setZone(pointId, zoneTag) {
            if (zoneTag === null || zoneTag === '' || zoneTag === undefined) {
                const current = this.zoneOf(pointId);
                if (!current) return { pointId, zone: null };
                return { ...this.unassignTag(pointId, current), zone: null };
            }
            const reg = this.registry();
            if (!reg[zoneTag]) throw new Error(`zone inconnue : ${zoneTag} — la créer d’abord`);
            if (reg[zoneTag].type !== 'zone') throw new Error(`« ${zoneTag} » n’est pas de type zone`);
            return this.assignTag(pointId, zoneTag);
        },

        // ─── groupes de zones ────────────────────────────────────────────────

        createGroup(rawName, members = []) {
            const name = normaliseGroupName(rawName);
            const groups = this.groups();
            if (groups[name]) throw new Error(`le groupe « ${name} » existe déjà`);
            if (this.registry()[name]) throw new Error(`« ${name} » est déjà une étiquette`);
            return this.setGroupMembers(name, members, { creating: true });
        },

        setGroupMembers(name, members, { creating = false } = {}) {
            const groups = this.groups();
            if (!creating && !groups[name]) throw new Error('groupe inconnu : ' + name);

            const reg = this.registry();
            const clean = [], warnings = [];
            for (const raw of members || []) {
                const m = String(raw).trim();
                if (!m || m === name) { warnings.push(`membre ignoré : ${raw || '(vide)'}`); continue; }
                const isZone = reg[m] && reg[m].type === 'zone';
                const isGroup = !!groups[m] || (creating && m === name);
                if (!isZone && !isGroup) { warnings.push(`ni zone ni groupe, ignoré : ${m}`); continue; }
                if (!clean.includes(m)) clean.push(m);
            }

            const cycle = wouldCycle(groups, name, clean);
            if (cycle) throw new Error(`cycle refusé : ${cycle.join(' → ')}`);

            groups[name] = { ...(groups[name] || {}), members: clean };
            global.set('zoneGroups', groups);
            persist();
            const e = expand(groups, name);
            return { group: name, members: clean, zones: e.zones, warnings };
        },

        deleteGroup(name) {
            const groups = this.groups();
            if (!groups[name]) throw new Error('groupe inconnu : ' + name);
            delete groups[name];
            let orphaned = 0;
            for (const def of Object.values(groups)) {
                const before = (def.members || []).length;
                def.members = (def.members || []).filter((x) => x !== name);
                orphaned += before - def.members.length;
            }
            global.set('zoneGroups', groups);
            persist();
            return { deleted: name, removedFromParents: orphaned };
        },
    };

    // ─── propagation vers les profils COV ────────────────────────────────────
    //
    // Les profils COV s'affectent par étiquette. Renommer ou supprimer une
    // étiquette sans toucher `covTagAssignments` laisserait une affectation qui
    // ne mord sur rien : un réglage invisible et introuvable.

    function renameCovAssignments(from, to) {
        const list = global.get('covTagAssignments');
        if (!Array.isArray(list)) return 0;
        let n = 0;
        for (const a of list) if (a && a.tag === from) { a.tag = to; n++; }
        if (n) {
            global.set('covTagAssignments', list);
            try { global.set('covTagAssignments', list, 'file'); } catch (e) { /* magasin file */ }
        }
        return n;
    }

    function dropCovAssignments(tag) {
        const list = global.get('covTagAssignments');
        if (!Array.isArray(list)) return 0;
        const kept = list.filter((a) => !a || a.tag !== tag);
        const dropped = list.length - kept.length;
        if (dropped) {
            global.set('covTagAssignments', kept);
            try { global.set('covTagAssignments', kept, 'file'); } catch (e) { /* magasin file */ }
        }
        return dropped;
    }

    global.set('tagPolicy', policy);

    if (node && node.warn) {
        const inv = policy.inventory();
        const detail = firstRun
            ? `migration : ${migration.zonesCreated.length} zone(s), ` +
              `${migration.groupsCreated.length} groupe(s), ` +
              `${migration.tagsRemoved.length} étiquette(s) redondante(s) converties`
            : `${migration.added.length} étiquette(s) classée(s), ${migration.rederived} zone(s) recalculée(s)`;
        node.warn(`✓ Taxonomie : ${inv.zone.length} zones · ${inv.group.length} groupes · ` +
                  `${inv.function.length} fonctions · ${inv.role.length} rôles · ${inv.other.length} autres — ${detail}`);
    }
    return policy;
};

module.exports.TAG_TYPES = TAG_TYPES;
module.exports.PREDEFINED = PREDEFINED;
module.exports.REDUNDANT_TO_GROUP = REDUNDANT_TO_GROUP;
module.exports.normaliseTag = normaliseTag;
module.exports.normaliseGroupName = normaliseGroupName;
module.exports.classify = classify;
module.exports.expand = expand;
module.exports.wouldCycle = wouldCycle;
