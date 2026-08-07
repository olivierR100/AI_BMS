'use strict';
/*
 * Pilote BACnet/IP — le point de contact avec du matériel réel.
 *
 * Principe directeur : ce pilote maintient la table `bacnetPoints` en phase
 * avec un serveur BACnet distant. Tout ce qui est au-dessus — le moteur de
 * règles, le Control Panel, le Device Manager, l'assistant IA — continue de
 * lire cette table et n'a aucune idée qu'un réseau est apparu dessous.
 *
 * Sens des flux :
 *   serveur → BMS : souscriptions COV. Pas d'interrogation en boucle : on est
 *                   notifié des changements. Un rafraîchissement périodique par
 *                   ReadPropertyMultiple sert de filet (COV perdues, reprise).
 *   BMS → serveur : WriteProperty avec priorité (8 par défaut, la priorité
 *                   « opérateur manuel » habituelle d'une GTB).
 *
 * Liaison des points : par `object-name`. Le simulateur nomme ses objets avec
 * l'identifiant du fait (`f1_lobby_temp`), donc la liaison est automatique. Un
 * automate réel nomme rarement aussi bien : `bacnetBindings` permet alors une
 * correspondance explicite, posée depuis l'interface.
 *
 * Volume de notifications : voir `../cov.js`. L'incrément d'un point voyage dans
 * la requête d'abonnement, par **SubscribeCOVProperty** — le serveur garde une
 * valeur de référence propre à notre abonnement, et notre réglage n'affecte
 * aucun autre superviseur. Un appareil qui n'annonce pas ce service dans
 * `Protocol_Services_Supported` ne peut pas recevoir de réglage d'incrément : le
 * pilote le signale, et l'interface masque alors ces commandes au lieu de faire
 * croire à un réglage qui n'existe pas.
 *
 * Le plafond de cadence et le battement de cœur, eux, restent appliqués ici :
 * SubscribeCOVProperty ne les transporte pas (SubscribeCOVPropertyMultiple a un
 * `maxNotificationDelay` qui s'en rapproche, mais la bibliothèque n'encode pas ce
 * service).
 *
 * Limites assumées (cf. l'étude préalable) :
 *   - BACnet/IP uniquement. MS/TP suppose un routeur IP en amont.
 *   - Les requêtes RPM sont envoyées par lots courts : la segmentation SORTANTE
 *     n'existe dans aucune pile JS.
 *   - Les appels sont sérialisés : le `_segmentStore` de la bibliothèque n'est
 *     pas indexé par pair, et des réponses segmentées concurrentes se
 *     mélangeraient.
 */

const { gateValue, releasePending } = require('../cov');
const covProperty = require('./cov-property');

const QUALITY = { GOOD: 'good', STALE: 'stale', UNRELIABLE: 'unreliable', UNKNOWN: 'unknown' };

const DEFAULTS = {
    port: 47808,
    clientPort: 47809,
    deviceId: null,          // null = découvert via Who-Is
    priority: 8,
    covLifetime: 3600,       // secondes ; renouvelé à la moitié
    refreshMs: 0,            // 0 = pur COV, aucun sondage périodique
    apduTimeout: 6000,
    rpmBatch: 12,            // court : pas de segmentation sortante
    sweepMs: 500,            // cadence du balayage (fenêtres de cadence, battements)
};

/** BACnet REAL est un flottant 32 bits : 21.3 revient en 21.299999237060547. */
const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);

function createBacnetDriver(ctx, userConfig) {
    const { global, node } = ctx;
    const config = { ...DEFAULTS, ...(userConfig || {}) };

    let bacnet = null;
    try {
        bacnet = require('@bacnet-js/client');
    } catch (e) {
        throw new Error("le paquet @bacnet-js/client n'est pas installé dans le userDir");
    }
    const { ObjectType, PropertyIdentifier, ApplicationTag, BinaryPV } = bacnet;

    let client = null;
    let connected = false;
    let lastError = null;
    let refreshTimer = null;
    let renewTimer = null;
    let sweepTimer = null;
    let covCount = 0;
    let connectedAt = null;

    /** factId → { objectId, isBool, writable } */
    const bindings = new Map();
    /** clé "type:instance" → factId, pour router les notifications COV */
    const byObject = new Map();
    /** factId → horodatage de la dernière valeur reçue */
    const lastSeen = new Map();

    /*
     * État du profil COV, par point :
     *   policy  — { increment, minIntervalMs, heartbeatMs, source } résolu
     *   gates   — { lastApplied, pending } pour le plafond de cadence
     *   applied — incrément réellement écrit dans l'appareil distant
     *   rate    — compteur de notifications par minute, sur une heure glissante
     */
    const policyCache = new Map();
    const gates = new Map();
    /** factId → incrément réellement porté par l'abonnement en cours. */
    const appliedIncrements = new Map();
    const rateBuckets = new Map();
    const covCounts = new Map();
    const lastHeartbeatTry = new Map();

    const target = () => ({ address: `${config.host}:${config.port}` });
    const key = (o) => `${o.type}:${o.instance}`;
    const warn = (m) => { if (node && node.warn) node.warn('[bacnet] ' + m); };

    // ─── compteur de notifications ───────────────────────────────────────────
    //
    // 60 seaux d'une minute par point : trier là-dessus est la façon concrète de
    // trouver le point mal réglé au milieu de 86.

    const RATE_WINDOW_MIN = 60;

    function advanceBuckets(r, minute) {
        if (r.minute === minute) return;
        const gap = Math.min(RATE_WINDOW_MIN, minute - r.minute);
        for (let i = 1; i <= gap; i++) r.counts[(r.minute + i) % RATE_WINDOW_MIN] = 0;
        r.minute = minute;
    }

    function countNotification(factId) {
        covCounts.set(factId, (covCounts.get(factId) || 0) + 1);
        const minute = Math.floor(Date.now() / 60000);
        let r = rateBuckets.get(factId);
        if (!r) { r = { minute, counts: new Array(RATE_WINDOW_MIN).fill(0) }; rateBuckets.set(factId, r); }
        advanceBuckets(r, minute);
        r.counts[minute % RATE_WINDOW_MIN]++;
    }

    /** factId → notifications par minute mesurées sur la fenêtre. */
    function rates() {
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        // Fenêtre réellement observée : sinon les premières minutes après la
        // connexion afficheraient un taux divisé par 60.
        const observedMin = connectedAt
            ? Math.min(RATE_WINDOW_MIN, Math.max(1, (now - connectedAt) / 60000))
            : 1;
        const out = {};
        for (const factId of bindings.keys()) {
            const r = rateBuckets.get(factId);
            if (!r) { out[factId] = 0; continue; }
            advanceBuckets(r, minute);
            const total = r.counts.reduce((a, b) => a + b, 0);
            out[factId] = Math.round((total / observedMin) * 10) / 10;
        }
        return out;
    }

    // ─── services annoncés par l'appareil ────────────────────────────────────

    /*
     * `Protocol_Services_Supported` est la réponse honnête à « puis-je régler un
     * incrément sur cet appareil ? ». On la lit une fois à la connexion, et
     * l'interface s'y conforme : proposer un réglage qu'un automate ignore serait
     * pire que ne rien proposer.
     */
    let capabilities = {
        subscribeCovProperty: false,
        subscribeCovPropertyMultiple: false,
        covIncrementSettable: false,
        reason: 'non interrogé',
    };

    const SERVICE_BIT = {
        readProperty: 12,                     // obligatoire : sert de témoin
        subscribeCovProperty: 38,
        subscribeCovPropertyMultiple: 41,
    };

    /*
     * Ordre des bits : sur le fil, un bitstring BACnet est en poids fort d'abord,
     * mais `@bacnet-js/client` retourne les octets à l'encodage comme au
     * décodage (`byteReverseBits`). La représentation qui nous parvient est donc
     * toujours en poids FAIBLE d'abord, quel que soit l'automate en face.
     */
    function bitSet(bitstring, bit) {
        if (!bitstring) return false;
        const bytes = bitstring.value || bitstring.bitString || bitstring;
        if (!bytes || typeof bytes.length !== 'number') return false;
        const byte = bytes[bit >> 3];
        if (byte === undefined) return false;
        return (byte & (1 << (bit & 7))) !== 0;
    }

    async function readCapabilities() {
        const encoderReady = covProperty.isAvailable();
        try {
            const res = await client.readProperty(target(),
                { type: ObjectType.DEVICE, instance: config.deviceId },
                PropertyIdentifier.PROTOCOL_SERVICES_SUPPORTED);
            const raw = res.values[0] && res.values[0].value;

            /*
             * Témoin : ReadProperty est obligatoire pour tout appareil BACnet, et
             * on vient justement de s'en servir pour lire cette propriété. Si son
             * bit ne ressort pas, ce n'est pas l'appareil qui est en cause, c'est
             * notre lecture du bitstring. Le dire, plutôt que d'annoncer
             * tranquillement que rien n'est supporté.
             */
            if (!bitSet(raw, SERVICE_BIT.readProperty)) {
                capabilities = {
                    subscribeCovProperty: false, subscribeCovPropertyMultiple: false,
                    covIncrementSettable: false,
                    reason: 'Protocol_Services_Supported illisible : le bit ReadProperty, ' +
                            'obligatoire, ne ressort pas — l’ordre des bits a changé',
                };
                warn(capabilities.reason);
                return capabilities;
            }

            const single = bitSet(raw, SERVICE_BIT.subscribeCovProperty);
            const multiple = bitSet(raw, SERVICE_BIT.subscribeCovPropertyMultiple);
            capabilities = {
                subscribeCovProperty: single,
                subscribeCovPropertyMultiple: multiple,
                covIncrementSettable: single && encoderReady,
                reason: !single
                    ? "l'appareil n'annonce pas SubscribeCOVProperty : l'incrément n'est pas réglable par abonnement"
                    : !encoderReady
                        ? "la bibliothèque cliente n'expose plus l'encodage de l'incrément"
                        : 'SubscribeCOVProperty annoncé par l’appareil',
            };
        } catch (e) {
            // Un appareil qui ne sait pas répondre est un appareil sur lequel on
            // ne réglera rien : le dire, plutôt que de supposer.
            capabilities = {
                subscribeCovProperty: false, subscribeCovPropertyMultiple: false,
                covIncrementSettable: false,
                reason: 'Protocol_Services_Supported illisible : ' + e.message,
            };
        }
        return capabilities;
    }

    // ─── profils COV ─────────────────────────────────────────────────────────

    /** Relit les profils depuis le contexte. Appelé à la connexion et à chaque édition. */
    function refreshPolicies() {
        const cov = global.get('covPolicy');
        policyCache.clear();
        if (!cov) return;
        for (const factId of bindings.keys()) policyCache.set(factId, cov.resolve(factId));
    }

    const policyFor = (factId) => policyCache.get(factId) || null;

    // ─── parcours ────────────────────────────────────────────────────────────

    /** Lit l'object-list du device, puis le nom de chaque objet. */
    async function browse() {
        if (!client) throw new Error('non connecté');

        const deviceId = config.deviceId;
        if (deviceId === null || deviceId === undefined) throw new Error('deviceId inconnu');

        const list = await client.readProperty(target(),
            { type: ObjectType.DEVICE, instance: deviceId }, PropertyIdentifier.OBJECT_LIST);

        const found = [];
        for (const entry of list.values) {
            const objectId = entry.value;
            if (objectId.type === ObjectType.DEVICE) continue;

            // Sérialisé volontairement : voir la note sur _segmentStore.
            let name = null, description = null;
            try {
                const n = await client.readProperty(target(), objectId, PropertyIdentifier.OBJECT_NAME);
                name = n.values[0].value;
            } catch (e) { /* objet sans nom lisible */ }
            try {
                const d = await client.readProperty(target(), objectId, PropertyIdentifier.DESCRIPTION);
                description = d.values[0].value;
            } catch (e) { /* facultatif */ }

            found.push({
                objectId,
                type: objectId.type,
                instance: objectId.instance,
                name,
                description,
                isBool: objectId.type === ObjectType.BINARY_VALUE
                     || objectId.type === ObjectType.BINARY_INPUT
                     || objectId.type === ObjectType.BINARY_OUTPUT,
                writable: objectId.type !== ObjectType.ANALOG_INPUT
                       && objectId.type !== ObjectType.BINARY_INPUT,
            });
        }
        return found;
    }

    /**
     * Associe les objets distants aux points du BMS.
     * Priorité à `bacnetBindings` (liaison explicite), sinon par object-name.
     */
    function bind(objects) {
        const bacnetPoints = global.get('bacnetPoints') || {};
        const explicit = global.get('bacnetBindings') || {};

        bindings.clear();
        byObject.clear();

        const byName = new Map(objects.filter((o) => o.name).map((o) => [o.name, o]));
        const unmatched = [];

        for (const factId of Object.keys(bacnetPoints)) {
            let obj = null;

            const hint = explicit[factId];
            if (hint) {
                obj = objects.find((o) => o.type === hint.type && o.instance === hint.instance) || null;
            } else if (byName.has(factId)) {
                obj = byName.get(factId);
            }

            if (!obj) { unmatched.push(factId); continue; }

            // `processId` STABLE par point : c'est la clé d'abonnement côté
            // serveur. Un identifiant qui bougerait ferait s'empiler des
            // abonnements fantômes à chaque réabonnement.
            bindings.set(factId, {
                objectId: obj.objectId, isBool: obj.isBool, writable: obj.writable,
                processId: bindings.size + 1,
            });
            byObject.set(key(obj.objectId), factId);
        }

        const extras = objects.filter((o) => !byObject.has(key(o.objectId)));
        return { bound: bindings.size, unmatched, unbound: extras };
    }

    // ─── valeurs ─────────────────────────────────────────────────────────────

    /** Écrit la valeur dans la table des points. Rien d'autre ne la modifie. */
    function commit(factId, value) {
        const bacnetPoints = global.get('bacnetPoints') || {};
        const p = bacnetPoints[factId];
        if (!p) return;
        if (p.value !== value) {
            p.value = value;
            global.set('bacnetPoints', bacnetPoints);
        }
    }

    /**
     * `gated: true` n'est vrai que pour les notifications COV : le plafond de
     * cadence n'a de sens que sur ce que l'appareil pousse spontanément. Une
     * lecture explicite (RPM, battement de cœur) ou une relecture après écriture
     * sont des actes délibérés, et une règle qui vient d'écrire doit relire ce
     * qu'elle a commandé sans attendre l'ouverture d'une fenêtre.
     */
    function applyValue(factId, raw, isBool, { gated = false } = {}) {
        const bacnetPoints = global.get('bacnetPoints') || {};
        if (!bacnetPoints[factId]) return;

        const value = isBool ? (raw === BinaryPV.ACTIVE || raw === 1 || raw === true) : round1(raw);

        // Reçu = vu, même si la valeur est retenue en aval : c'est bien la
        // preuve que le lien est vivant.
        lastSeen.set(factId, Date.now());

        if (!gated) {
            let g = gates.get(factId);
            if (!g) { g = {}; gates.set(factId, g); }
            g.lastApplied = Date.now();
            g.pending = undefined;
            commit(factId, value);
            return;
        }

        const pol = policyFor(factId);
        const minInterval = (pol && pol.minIntervalMs) || 0;
        let g = gates.get(factId);
        if (!g) { g = {}; gates.set(factId, g); }

        const allowed = gateValue(g, value, minInterval, Date.now());
        if (allowed !== null) commit(factId, allowed);
    }

    function onCov(data) {
        try {
            const monitored = data.payload.monitoredObjectId || data.payload.monitoredObject;
            if (!monitored) return;
            const factId = byObject.get(key(monitored));
            if (!factId) return;

            const b = bindings.get(factId);
            for (const v of data.payload.values || []) {
                if (v.property.id !== PropertyIdentifier.PRESENT_VALUE) continue;
                // Compté avant le plafond de cadence : la métrique doit dire ce
                // que le réseau a porté, pas ce que le BMS a retenu.
                countNotification(factId);
                covCount++;
                applyValue(factId, v.value[0].value, b.isBool, { gated: true });
            }
        } catch (e) {
            warn('notification COV illisible : ' + e.message);
        }
    }

    /**
     * Abonne (ou réabonne) une liste de points.
     *
     * Deux voies, selon ce que l'appareil annonce :
     *   - SubscribeCOVProperty, en portant l'incrément du profil. Le serveur
     *     tient une référence par abonnement, donc notre réglage n'engage que
     *     nous. C'est la voie souhaitée.
     *   - SubscribeCOV simple, sinon. L'incrément n'est alors pas réglable : la
     *     bande morte est celle que l'appareil porte sur ses objets.
     *
     * L'identifiant de processus est STABLE par point (posé à la liaison) : le
     * serveur s'en sert comme clé, donc réémettre une requête met l'abonnement à
     * jour au lieu d'en créer un second.
     */
    async function subscribeSome(factIds) {
        let ok = 0, failed = 0, withIncrement = 0;
        const errors = [];
        const usePropertyService = capabilities.covIncrementSettable;

        for (const factId of factIds) {
            const b = bindings.get(factId);
            if (!b) continue;
            const pol = policyFor(factId);
            // Un binaire n'a pas d'incrément : toute transition notifie.
            const increment = (usePropertyService && pol && !b.isBool && pol.increment !== null)
                ? pol.increment : null;
            try {
                if (usePropertyService) {
                    await covProperty.subscribeCovProperty(client, target(), b.objectId,
                        PropertyIdentifier.PRESENT_VALUE, b.processId,
                        { increment, lifetime: config.covLifetime, confirmed: false });
                    if (increment !== null) { appliedIncrements.set(factId, increment); withIncrement++; }
                } else {
                    await client.subscribeCov(target(), b.objectId, b.processId, false, false, config.covLifetime);
                    appliedIncrements.delete(factId);
                }
                ok++;
            } catch (e) {
                failed++;
                if (errors.length < 3) errors.push(`${factId} : ${e.message}`);
            }
        }
        if (failed) {
            warn(`${failed} souscription(s) COV refusée(s) — ces points ne vivront que du ` +
                 `rafraîchissement périodique. ${errors.join(' · ')}`);
        }
        return { ok, failed, withIncrement, errors, service: usePropertyService ? 'SubscribeCOVProperty' : 'SubscribeCOV' };
    }

    async function subscribeAll() {
        return subscribeSome([...bindings.keys()]);
    }

    /** Filet de sécurité : relit tout, par petits lots. */
    async function refreshAll() {
        return readSome([...bindings.keys()]);
    }

    /** Relit un sous-ensemble de points par RPM, en lots courts. */
    async function readSome(factIds) {
        if (!connected) return { read: 0 };
        const entries = factIds
            .filter((id) => bindings.has(id))
            .map((id) => [id, bindings.get(id)]);
        let read = 0;

        for (let i = 0; i < entries.length; i += config.rpmBatch) {
            const batch = entries.slice(i, i + config.rpmBatch);
            try {
                const res = await client.readPropertyMultiple(target(), batch.map(([, b]) => ({
                    objectId: b.objectId,
                    properties: [{ id: PropertyIdentifier.PRESENT_VALUE }],
                })));
                for (const item of res.values) {
                    const factId = byObject.get(key(item.objectId));
                    if (!factId) continue;
                    const b = bindings.get(factId);
                    const v = item.values[0] && item.values[0].value[0];
                    if (v === undefined) continue;
                    applyValue(factId, v.value, b.isBool);
                    read++;
                }
            } catch (e) {
                warn(`RPM en échec sur un lot de ${batch.length} : ${e.message}`);
            }
        }
        return { read };
    }

    // ─── application des profils COV ─────────────────────────────────────────

    /**
     * Pousse les incréments du profil vers l'appareil, en RÉÉMETTANT
     * l'abonnement des points dont l'incrément a changé.
     *
     * C'est SubscribeCOVProperty qui porte le réglage : le serveur remplace
     * l'enregistrement de même clé (adresse + processId + objet + propriété) et
     * conserve la valeur de référence de l'abonnement en cours. Rien n'est écrit
     * dans l'appareil, donc rien n'est imposé aux autres superviseurs.
     *
     * Les objets binaires sont hors sujet : toute transition notifie.
     *
     * @param {boolean} force  réémet même les abonnements déjà à jour
     */
    async function applyCovPolicy({ force = false } = {}) {
        if (!connected) return { written: 0, skipped: 0, failed: 0, unchanged: 0, capabilities };
        refreshPolicies();

        if (!capabilities.covIncrementSettable) {
            // Rien à pousser, et surtout : ne pas prétendre le contraire.
            // L'interface se sert de `capabilities.reason` pour l'expliquer.
            return {
                written: 0, failed: 0, unchanged: 0, skipped: bindings.size,
                unsupported: true, capabilities, errors: [],
            };
        }

        const stale = [];
        let skipped = 0, unchanged = 0;
        for (const [factId, b] of bindings) {
            const pol = policyFor(factId);
            if (b.isBool || !pol || pol.increment === null) { skipped++; continue; }
            if (!force && appliedIncrements.get(factId) === pol.increment) { unchanged++; continue; }
            stale.push(factId);
        }

        const res = stale.length ? await subscribeSome(stale) : { ok: 0, failed: 0, errors: [] };

        if (res.failed) {
            warn(`${res.failed} réabonnement(s) refusé(s) — ces points gardent l'incrément de leur ` +
                 `abonnement précédent. ${res.errors.join(' · ')}`);
        }

        // Sur du matériel réel, un réabonnement en masse est un geste
        // d'exploitation : une trace de synthèse, pas une par point — le journal
        // des commandes est un anneau de 500, et le noyer effacerait
        // l'historique utile.
        const written = res.ok;
        if ((written || res.failed) && global.get('bacnetMode') === 'real') {
            const safety = global.get('bmsSafety');
            if (safety && safety.record) {
                safety.record('(cov-subscriptions)', written, 'cov-profile',
                    { ok: res.failed === 0, error: res.failed ? `${res.failed} refus : ${res.errors.join(' · ')}` : null });
            }
        }
        return {
            written, failed: res.failed, skipped, unchanged,
            errors: res.errors || [], service: res.service, capabilities,
        };
    }

    /**
     * Balayage : libère les valeurs retenues par le plafond de cadence, et
     * relit les points restés silencieux plus longtemps que leur battement de
     * cœur. Un seul minuteur pour les 86 points — pas un par point.
     */
    /*
     * Un seul lot de requêtes en vol à la fois, pour les appels DÉCLENCHÉS PAR
     * MINUTEUR. Sans ce verrou, un battement de cœur lent verrait le balayage
     * suivant démarrer par-dessus, et deux RPM concurrents se mélangeraient dans
     * le `_segmentStore` de la bibliothèque — la sérialisation promise en tête de
     * fichier ne tiendrait plus. Les appels explicites (connexion, parcours
     * demandé depuis l'interface) restent libres : ils sont rares et volontaires.
     */
    let timerBusy = false;

    function onTimer(fn) {
        return () => {
            if (timerBusy) return;
            timerBusy = true;
            Promise.resolve()
                .then(fn)
                .catch(() => {})
                .finally(() => { timerBusy = false; });
        };
    }

    async function sweep() {
        if (!connected) return;
        const now = Date.now();

        // 1. Fenêtres de cadence qui s'ouvrent.
        for (const [factId, g] of gates) {
            if (g.pending === undefined) continue;
            const pol = policyFor(factId);
            const released = releasePending(g, (pol && pol.minIntervalMs) || 0, now);
            if (released !== undefined) commit(factId, released);
        }

        // 2. Battements de cœur : points silencieux depuis trop longtemps.
        const silent = [];
        for (const factId of bindings.keys()) {
            const pol = policyFor(factId);
            if (!pol || !pol.heartbeatMs) continue;
            const seen = lastSeen.get(factId) || connectedAt || now;
            if (now - seen < pol.heartbeatMs) continue;
            // Ne pas marteler un lien mort : une tentative par période au plus.
            const tried = lastHeartbeatTry.get(factId) || 0;
            if (now - tried < pol.heartbeatMs) continue;
            lastHeartbeatTry.set(factId, now);
            silent.push(factId);
        }
        if (silent.length) {
            // Une lecture qui échoue laisse `lastSeen` en arrière — c'est
            // précisément le signal que `pointStaleAfter` doit voir.
            await readSome(silent).catch(() => {});
        }
    }

    // ─── cycle de vie ────────────────────────────────────────────────────────

    async function connect() {
        if (connected) return status();
        if (!config.host) throw new Error('adresse du serveur BACnet non renseignée');

        client = new bacnet.default({
            port: config.clientPort,
            interface: config.interface || '0.0.0.0',
            broadcastAddress: config.broadcastAddress || '255.255.255.255',
            apduTimeout: config.apduTimeout,
        });
        client.on('covNotifyUnconfirmed', onCov);
        client.on('covNotify', onCov);
        client.on('error', (e) => { lastError = String(e && e.message || e); });

        // Découverte du deviceId si l'utilisateur ne l'a pas fourni : Who-Is
        // dirigé vers l'hôte, pas en diffusion — la diffusion ne traverse pas
        // le NAT de WSL2.
        if (config.deviceId === null || config.deviceId === undefined) {
            const iams = [];
            const onIam = (d) => iams.push(d);
            client.on('iAm', onIam);
            client.whoIs(target());
            await new Promise((r) => setTimeout(r, 2000));
            client.removeListener('iAm', onIam);
            if (!iams.length) {
                client.close();
                client = null;
                throw new Error(`aucune réponse I-Am de ${config.host}:${config.port}`);
            }
            config.deviceId = iams[0].payload.deviceId;
        }

        const objects = await browse();
        const result = bind(objects);
        connected = true;
        connectedAt = Date.now();
        lastError = null;

        // Dans cet ordre, et il compte : savoir ce que l'appareil accepte, puis
        // résoudre les profils, puis s'abonner en portant déjà les incréments.
        // S'abonner d'abord produirait la volée de notifications qu'on cherche
        // précisément à éviter.
        const caps = await readCapabilities();
        refreshPolicies();
        const cov = await subscribeAll();
        await refreshAll();

        // Sondage périodique : DÉSACTIVÉ par défaut (refreshMs = 0). Le lien est
    // piloté par les notifications COV, donc au repos il ne circule rien. Le
    // prix à payer : une COV perdue (UDP n'est pas fiable) passe inaperçue
    // jusqu'au prochain changement. C'est ce que `pointStaleAfter` sert à
    // détecter. Mettre refreshMs > 0 rétablit un filet de sécurité RPM.
    if (config.refreshMs > 0) {
        refreshTimer = setInterval(onTimer(refreshAll), config.refreshMs);
    }
        // Les souscriptions COV expirent : on les renouvelle à mi-vie.
        renewTimer = setInterval(onTimer(subscribeAll), config.covLifetime * 500);

        // Plafonds de cadence et battements de cœur : voir sweep().
        sweepTimer = setInterval(onTimer(sweep), config.sweepMs);

        return { ...status(), browse: result, cov, capabilities: caps, objects: objects.length };
    }

    function disconnect() {
        if (refreshTimer) clearInterval(refreshTimer);
        if (renewTimer) clearInterval(renewTimer);
        if (sweepTimer) clearInterval(sweepTimer);
        refreshTimer = renewTimer = sweepTimer = null;
        if (client) { try { client.close(); } catch (e) { /* déjà fermé */ } }
        client = null;
        connected = false;
        connectedAt = null;
        bindings.clear();
        byObject.clear();
        lastSeen.clear();
        policyCache.clear();
        gates.clear();
        appliedIncrements.clear();
        rateBuckets.clear();
        covCounts.clear();
        lastHeartbeatTry.clear();
    }

    function status() {
        return {
            name: 'bacnet',
            connected,
            host: config.host,
            port: config.port,
            deviceId: config.deviceId,
            bound: bindings.size,
            covReceived: covCount,
            covIncrementsApplied: appliedIncrements.size,
            capabilities,
            lastError,
        };
    }

    // ─── contrat de pilote ───────────────────────────────────────────────────

    return {
        name: 'bacnet',
        config,
        connect, disconnect, browse, refreshAll, readSome, status,
        bindings,

        // Profils COV : `applyCovPolicy` est rappelé après chaque édition depuis
        // l'API, `rates` alimente la colonne « notif/min » du Device Manager.
        applyCovPolicy, refreshPolicies, rates, subscribeSome,
        /** Ce que l'appareil annonce savoir faire — l'interface s'y conforme. */
        capabilities() { return capabilities; },
        /** Compteur cumulé par point, depuis la connexion. */
        counts() { return Object.fromEntries(covCounts); },
        appliedIncrement(factId) {
            return appliedIncrements.has(factId) ? appliedIncrements.get(factId) : null;
        },

        isHealthy() { return connected && !lastError; },

        read(factId) {
            const bacnetPoints = global.get('bacnetPoints') || {};
            const p = bacnetPoints[factId];
            const ts = lastSeen.get(factId) || null;
            if (!p) return { value: undefined, quality: QUALITY.UNKNOWN, ts: null };
            if (!connected) return { value: p.value, quality: QUALITY.UNRELIABLE, ts };
            return { value: p.value, quality: ts ? QUALITY.GOOD : QUALITY.UNKNOWN, ts };
        },

        async write(factId, value, opts) {
            if (!connected) return { ok: false, error: 'serveur BACnet non connecté' };
            const b = bindings.get(factId);
            if (!b) return { ok: false, error: 'point non lié à un objet BACnet : ' + factId };
            if (!b.writable) return { ok: false, error: 'objet BACnet en lecture seule : ' + factId };

            const priority = (opts && opts.priority) || config.priority;
            const payload = b.isBool
                ? [{ type: ApplicationTag.ENUMERATED, value: value ? BinaryPV.ACTIVE : BinaryPV.INACTIVE }]
                : [{ type: ApplicationTag.REAL, value: Number(value) }];

            try {
                await client.writeProperty(target(), b.objectId,
                    PropertyIdentifier.PRESENT_VALUE, payload, { priority });
                // On applique localement sans attendre la COV de retour : la
                // règle qui vient d'écrire doit relire ce qu'elle a commandé.
                applyValue(factId, b.isBool ? (value ? BinaryPV.ACTIVE : BinaryPV.INACTIVE) : value, b.isBool);
                return { ok: true, value: round1(value) };
            } catch (e) {
                return { ok: false, error: `écriture BACnet refusée sur ${factId} : ${e.message}` };
            }
        },
    };
}

module.exports = { createBacnetDriver, QUALITY };
