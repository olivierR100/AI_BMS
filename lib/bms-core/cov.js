'use strict';
/*
 * Profils COV — combien de notifications un point a le droit de produire.
 *
 * Le problème concret : la physique remue 86 points toutes les 2 s, et sans
 * bande morte chaque frémissement traverse le réseau. ~20 notifications/s pour
 * un bâtiment au repos, ce qu'aucune GTB réelle ne tolère.
 *
 * ─── Sémantique ─────────────────────────────────────────────────────────────
 *
 * Un profil est une table CREUSE unité → incrément, pas un réglage scalaire :
 *
 *   { name: 'CO2 fin', increments: { ppm: 10 } }
 *
 * Conséquence à énoncer dans l'interface : appliquer « CO2 fin » à 40 points
 * n'en touche que ceux en ppm. Les autres n'ont pas d'incrément défini dans ce
 * profil, donc le profil ne les concerne pas — et c'est le comportement voulu,
 * pas un oubli.
 *
 * Le profil « default » est le socle : il couvre toutes les unités connues.
 *
 * Précédence, du plus fort au plus faible :
 *   1. surcharge par point   (`covOverrides[id] = 'nom de profil'`)
 *   2. affectation par étiquette (`covTagAssignments`, liste ORDONNÉE)
 *   3. profil « default »
 *
 * La chaîne est parcourue dans cet ordre et le PREMIER profil qui définit
 * l'unité du point gagne — pour l'incrément comme pour la cadence. Un profil
 * qui ne couvre pas l'unité est simplement transparent. La provenance du
 * résultat est renvoyée avec lui (`manual`, `tag:meeting`, `default`) : sans
 * elle, personne ne peut expliquer pourquoi un point se comporte autrement que
 * son voisin.
 *
 * L'affectation par étiquette est le mécanisme principal — un point qui reçoit
 * l'étiquette hérite du réglage sans intervention. L'application en masse (qui
 * écrit des surcharges par point) sert aux exceptions.
 *
 * ─── Où chaque réglage est réellement appliqué ───────────────────────────────
 *
 * `increment`  → écrit dans la propriété BACnet `COV_Increment` de l'objet
 *                distant. C'est le mécanisme normalisé : la bande morte vit
 *                dans l'appareil, qui n'émet plus la notification du tout.
 *                Fonctionne sur le simulateur comme sur un automate réel.
 *
 * `minIntervalMs` et `heartbeatMs` → appliqués CÔTÉ BMS, dans le pilote.
 *                BACnet n'a pas de représentation sur le fil pour l'un ni pour
 *                l'autre : SubscribeCOV ne transporte qu'une durée de vie
 *                d'abonnement. Ce sont donc des politiques du BMS :
 *                  - minIntervalMs plafonne la cadence à laquelle un point
 *                    bavard peut remuer les règles et le dashboard (la dernière
 *                    valeur reçue est conservée et appliquée à l'ouverture de
 *                    la fenêtre — rien n'est perdu, seulement retardé) ;
 *                  - heartbeatMs relit le point quand il est resté silencieux
 *                    trop longtemps, ce qui distingue « rien n'a bougé » de
 *                    « le lien est mort ». Un automate réel n'offre pas de
 *                    battement de cœur non sollicité ; le relire est la seule
 *                    façon honnête d'obtenir la même information.
 */

/** Incréments par défaut, par unité. `bool` = 0 : toute transition notifie. */
const UNIT_DEFAULTS = {
    '°C': 0.2,
    '%': 2,
    'ppm': 25,
    'lux': 20,
    'bool': 0,
};

const DEFAULT_PROFILE_NAME = 'default';

/** Le socle : couvre toutes les unités, sans plafond de cadence. */
function defaultProfile() {
    return {
        name: DEFAULT_PROFILE_NAME,
        increments: { ...UNIT_DEFAULTS },
        minIntervalMs: 0,
        heartbeatMs: 0,
        description: 'Socle appliqué à tout point qu’aucune règle plus précise ne couvre.',
    };
}

const UNITS = Object.keys(UNIT_DEFAULTS);

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Nettoie un profil venu de l'interface ou de l'API. Rend `{profile, warnings}`
 * plutôt que de lever : une valeur douteuse ne doit pas casser l'application
 * d'un profil par ailleurs correct, mais doit être signalée.
 */
function sanitizeProfile(raw, { isDefault = false } = {}) {
    const warnings = [];
    if (!raw || typeof raw !== 'object') throw new Error('profil attendu sous forme d’objet');

    const name = String(raw.name || '').trim();
    if (!name) throw new Error('un profil doit porter un nom');
    if (!isDefault && name === DEFAULT_PROFILE_NAME) {
        throw new Error(`« ${DEFAULT_PROFILE_NAME} » est le nom réservé du profil socle`);
    }

    const increments = {};
    for (const [unit, value] of Object.entries(raw.increments || {})) {
        if (!UNITS.includes(unit)) { warnings.push(`unité inconnue ignorée : ${unit}`); continue; }
        const v = num(value);
        if (v === null || v < 0) { warnings.push(`incrément invalide pour ${unit} : ${value}`); continue; }
        increments[unit] = v;
    }

    // Le socle doit rester complet : un point dont l'unité n'est couverte par
    // rien n'aurait aucune bande morte du tout.
    if (isDefault) {
        for (const unit of UNITS) {
            if (increments[unit] === undefined) {
                increments[unit] = UNIT_DEFAULTS[unit];
                warnings.push(`unité ${unit} absente du socle : incrément par défaut rétabli (${UNIT_DEFAULTS[unit]})`);
            }
        }
    } else if (Object.keys(increments).length === 0) {
        warnings.push('profil sans aucune unité : il ne s’appliquera à aucun point');
    }

    const clampMs = (v, label) => {
        const n = num(v);
        if (n === null) return 0;
        if (n < 0) { warnings.push(`${label} négatif ignoré`); return 0; }
        return Math.round(n);
    };
    const minIntervalMs = clampMs(raw.minIntervalMs, 'minIntervalMs');
    const heartbeatMs = clampMs(raw.heartbeatMs, 'heartbeatMs');
    if (heartbeatMs > 0 && minIntervalMs > 0 && heartbeatMs <= minIntervalMs) {
        warnings.push('heartbeatMs inférieur ou égal à minIntervalMs : le battement sera masqué par le plafond de cadence');
    }

    const profile = { name, increments, minIntervalMs, heartbeatMs };
    if (raw.description) profile.description = String(raw.description).slice(0, 200);
    return { profile, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution — fonction pure, testable sans contexte Node-RED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Incrément effectif d'un point et sa provenance.
 *
 * @param {object} args
 * @param {string} args.unit         unité du point ('°C', 'ppm', 'bool'…)
 * @param {string[]} args.tags       étiquettes du point
 * @param {string|null} args.override nom de profil forcé sur ce point
 * @param {object} args.profiles     table nom → profil (doit contenir 'default')
 * @param {Array} args.assignments   [{tag, profile}] ORDONNÉ, premier trouvé gagne
 * @returns {{increment:number|null, minIntervalMs:number, heartbeatMs:number,
 *            source:string, profile:string|null, unit:string}}
 */
function resolveFor({ unit, tags = [], override = null, profiles = {}, assignments = [] }) {
    const chain = [];

    if (override && profiles[override]) chain.push({ profile: profiles[override], source: 'manual' });
    for (const a of assignments) {
        if (!a || !a.tag || !profiles[a.profile]) continue;
        if (tags.includes(a.tag)) chain.push({ profile: profiles[a.profile], source: 'tag:' + a.tag });
    }
    const base = profiles[DEFAULT_PROFILE_NAME];
    if (base) chain.push({ profile: base, source: 'default' });

    for (const link of chain) {
        const inc = link.profile.increments ? link.profile.increments[unit] : undefined;
        if (inc === undefined) continue;          // profil creux : transparent pour cette unité
        return {
            unit,
            increment: inc,
            minIntervalMs: link.profile.minIntervalMs || 0,
            heartbeatMs: link.profile.heartbeatMs || 0,
            source: link.source,
            profile: link.profile.name,
        };
    }

    // Unité couverte par aucun profil, pas même le socle.
    return { unit, increment: null, minIntervalMs: 0, heartbeatMs: 0, source: 'none', profile: null };
}

/**
 * Plafond de cadence, isolé pour être testable : rend la valeur à appliquer
 * maintenant, ou `null` si elle doit attendre l'ouverture de la fenêtre.
 *
 * L'état (`{lastApplied, pending}`) est fourni par l'appelant et muté en place —
 * le pilote en garde une entrée par point.
 */
function gateValue(state, value, minIntervalMs, now) {
    if (!minIntervalMs || minIntervalMs <= 0) {
        state.lastApplied = now;
        state.pending = undefined;
        return value;
    }
    if (state.lastApplied === undefined || now - state.lastApplied >= minIntervalMs) {
        state.lastApplied = now;
        state.pending = undefined;
        return value;
    }
    // Fenêtre fermée : on garde la DERNIÈRE valeur reçue, pas la première.
    state.pending = value;
    return null;
}

/** Valeur en attente dont la fenêtre vient de s'ouvrir, ou `undefined`. */
function releasePending(state, minIntervalMs, now) {
    if (state.pending === undefined) return undefined;
    if (state.lastApplied !== undefined && now - state.lastApplied < minIntervalMs) return undefined;
    const v = state.pending;
    state.pending = undefined;
    state.lastApplied = now;
    return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Installation dans le contexte Node-RED
// ─────────────────────────────────────────────────────────────────────────────

const KEYS = ['covProfiles', 'covTagAssignments', 'covOverrides'];

module.exports = function installCov(ctx) {
    const { global, node } = ctx;

    // Restauration : magasin « file » d'abord (survit au redémarrage), puis ce
    // qui est déjà en mémoire (survit au redéploiement).
    for (const k of KEYS) {
        if (global.get(k) === undefined || global.get(k) === null) {
            let v;
            try { v = global.get(k, 'file'); } catch (e) { /* magasin file non configuré */ }
            if (v !== undefined && v !== null) global.set(k, v);
        }
    }

    if (!global.get('covProfiles')) global.set('covProfiles', { [DEFAULT_PROFILE_NAME]: defaultProfile() });
    if (!global.get('covTagAssignments')) global.set('covTagAssignments', []);
    if (!global.get('covOverrides')) global.set('covOverrides', {});

    // Le socle doit exister et rester complet même après une restauration
    // partielle : sans lui, aucun point n'aurait de bande morte.
    const profiles = global.get('covProfiles');
    const base = sanitizeProfile({ ...defaultProfile(), ...(profiles[DEFAULT_PROFILE_NAME] || {}), name: DEFAULT_PROFILE_NAME },
                                 { isDefault: true });
    profiles[DEFAULT_PROFILE_NAME] = base.profile;
    global.set('covProfiles', profiles);

    const persist = () => {
        for (const k of KEYS) {
            const v = global.get(k);
            global.set(k, v);
            try { global.set(k, v, 'file'); } catch (e) { /* magasin file non configuré */ }
        }
    };

    const unitOf = (id) => {
        const bp = global.get('bacnetPoints') || {};
        const p = bp[id];
        if (!p) return null;
        return p.units === 'bool' || typeof p.value === 'boolean' ? 'bool' : p.units;
    };

    const tagsOf = (id) => ((global.get('bmsMetadata') || {})[id] || {}).tags || [];

    const policy = {
        UNIT_DEFAULTS,
        DEFAULT_PROFILE_NAME,
        UNITS,

        profiles() { return global.get('covProfiles') || {}; },
        assignments() { return global.get('covTagAssignments') || []; },
        overrides() { return global.get('covOverrides') || {}; },

        /** Incrément effectif et provenance pour un point. */
        resolve(id) {
            const unit = unitOf(id);
            if (unit === null) return { unit: null, increment: null, minIntervalMs: 0, heartbeatMs: 0, source: 'none', profile: null };
            return resolveFor({
                unit,
                tags: tagsOf(id),
                override: this.overrides()[id] || null,
                profiles: this.profiles(),
                assignments: this.assignments(),
            });
        },

        /** Table complète, pour l'API et le Device Manager. */
        resolveAll() {
            const bp = global.get('bacnetPoints') || {};
            const out = {};
            for (const id of Object.keys(bp)) out[id] = this.resolve(id);
            return out;
        },

        /** Crée ou remplace un profil nommé (ou édite le socle). */
        setProfile(raw) {
            const isDefault = raw && String(raw.name || '').trim() === DEFAULT_PROFILE_NAME;
            const { profile, warnings } = sanitizeProfile(raw, { isDefault });
            const all = this.profiles();
            all[profile.name] = profile;
            global.set('covProfiles', all);
            persist();
            return { profile, warnings };
        },

        /**
         * Supprime un profil nommé, et avec lui toute référence pendante —
         * une affectation qui pointe vers un profil disparu serait un réglage
         * fantôme, exactement le genre de chose qu'on ne diagnostique jamais.
         */
        deleteProfile(name) {
            if (name === DEFAULT_PROFILE_NAME) throw new Error('le profil socle ne peut pas être supprimé');
            const all = this.profiles();
            if (!all[name]) throw new Error('profil inconnu : ' + name);
            delete all[name];
            global.set('covProfiles', all);

            const assignments = this.assignments().filter((a) => a.profile !== name);
            global.set('covTagAssignments', assignments);

            const overrides = this.overrides();
            let dropped = 0;
            for (const [id, p] of Object.entries(overrides)) {
                if (p === name) { delete overrides[id]; dropped++; }
            }
            global.set('covOverrides', overrides);
            persist();
            return { deleted: name, overridesDropped: dropped };
        },

        /** Remplace la liste ordonnée des affectations par étiquette. */
        setAssignments(list) {
            const profiles = this.profiles();
            const clean = [];
            const warnings = [];
            for (const a of list || []) {
                const tag = String((a && a.tag) || '').trim();
                const prof = String((a && a.profile) || '').trim();
                if (!tag || !prof) continue;
                if (!profiles[prof]) { warnings.push(`profil inconnu ignoré : ${prof}`); continue; }
                if (clean.some((x) => x.tag === tag)) { warnings.push(`étiquette en double ignorée : ${tag}`); continue; }
                clean.push({ tag, profile: prof });
            }
            global.set('covTagAssignments', clean);
            persist();
            return { assignments: clean, warnings };
        },

        /** Surcharge par point. `profileName === null` la retire. */
        setOverride(id, profileName) {
            const bp = global.get('bacnetPoints') || {};
            if (!bp[id]) throw new Error('point inconnu : ' + id);
            const overrides = this.overrides();
            if (profileName === null || profileName === '' || profileName === undefined) {
                delete overrides[id];
            } else {
                if (!this.profiles()[profileName]) throw new Error('profil inconnu : ' + profileName);
                overrides[id] = profileName;
            }
            global.set('covOverrides', overrides);
            persist();
            return this.resolve(id);
        },

        /**
         * Les deux nombres de la confirmation d'application en masse. Le second
         * est le seul cas destructeur : des points qui portent DÉJÀ une
         * surcharge manuelle, et qu'on écraserait.
         */
        preview(profileName, ids) {
            const profile = this.profiles()[profileName];
            if (!profile) throw new Error('profil inconnu : ' + profileName);
            const overrides = this.overrides();

            const matching = [], notMatching = [], manual = [];
            for (const id of ids || []) {
                const unit = unitOf(id);
                if (unit === null || profile.increments[unit] === undefined) { notMatching.push(id); continue; }
                matching.push(id);
                if (overrides[id] && overrides[id] !== profileName) manual.push(id);
            }
            return {
                profile: profileName,
                considered: (ids || []).length,
                matching, notMatching, manual,
                matchingCount: matching.length,
                notMatchingCount: notMatching.length,
                manualCount: manual.length,
            };
        },

        /** Application en masse : écrit des surcharges par point. */
        applyToPoints(profileName, ids, { overwriteManual = false } = {}) {
            const p = this.preview(profileName, ids);
            const overrides = this.overrides();
            const applied = [];
            for (const id of p.matching) {
                if (!overwriteManual && p.manual.includes(id)) continue;
                overrides[id] = profileName;
                applied.push(id);
            }
            global.set('covOverrides', overrides);
            persist();
            return {
                profile: profileName,
                applied, appliedCount: applied.length,
                skippedNoUnit: p.notMatchingCount,
                skippedManual: overwriteManual ? 0 : p.manualCount,
                overwrittenManual: overwriteManual ? p.manualCount : 0,
            };
        },
    };

    global.set('covPolicy', policy);
    if (node && node.warn) {
        const n = Object.keys(policy.profiles()).length;
        node.warn(`✓ Profils COV : ${n} profil(s), ` +
                  `${policy.assignments().length} affectation(s) par étiquette, ` +
                  `${Object.keys(policy.overrides()).length} surcharge(s) par point`);
    }
    return policy;
};

module.exports.UNIT_DEFAULTS = UNIT_DEFAULTS;
module.exports.DEFAULT_PROFILE_NAME = DEFAULT_PROFILE_NAME;
module.exports.defaultProfile = defaultProfile;
module.exports.sanitizeProfile = sanitizeProfile;
module.exports.resolveFor = resolveFor;
module.exports.gateValue = gateValue;
module.exports.releasePending = releasePending;
