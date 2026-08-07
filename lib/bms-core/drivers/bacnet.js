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
 * Limites assumées (cf. l'étude préalable) :
 *   - BACnet/IP uniquement. MS/TP suppose un routeur IP en amont.
 *   - Les requêtes RPM sont envoyées par lots courts : la segmentation SORTANTE
 *     n'existe dans aucune pile JS.
 *   - Les appels sont sérialisés : le `_segmentStore` de la bibliothèque n'est
 *     pas indexé par pair, et des réponses segmentées concurrentes se
 *     mélangeraient.
 */

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
    let covCount = 0;

    /** factId → { objectId, isBool, writable } */
    const bindings = new Map();
    /** clé "type:instance" → factId, pour router les notifications COV */
    const byObject = new Map();
    /** factId → horodatage de la dernière valeur reçue */
    const lastSeen = new Map();

    const target = () => ({ address: `${config.host}:${config.port}` });
    const key = (o) => `${o.type}:${o.instance}`;
    const warn = (m) => { if (node && node.warn) node.warn('[bacnet] ' + m); };

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

            bindings.set(factId, { objectId: obj.objectId, isBool: obj.isBool, writable: obj.writable });
            byObject.set(key(obj.objectId), factId);
        }

        const extras = objects.filter((o) => !byObject.has(key(o.objectId)));
        return { bound: bindings.size, unmatched, unbound: extras };
    }

    // ─── valeurs ─────────────────────────────────────────────────────────────

    function applyValue(factId, raw, isBool) {
        const bacnetPoints = global.get('bacnetPoints') || {};
        const p = bacnetPoints[factId];
        if (!p) return;

        const value = isBool ? (raw === BinaryPV.ACTIVE || raw === 1 || raw === true) : round1(raw);
        if (p.value !== value) {
            p.value = value;
            global.set('bacnetPoints', bacnetPoints);
        }
        lastSeen.set(factId, Date.now());
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
                applyValue(factId, v.value[0].value, b.isBool);
                covCount++;
            }
        } catch (e) {
            warn('notification COV illisible : ' + e.message);
        }
    }

    async function subscribeAll() {
        let ok = 0, failed = 0;
        let processId = 1;
        for (const [factId, b] of bindings) {
            try {
                await client.subscribeCov(target(), b.objectId, processId++, false, false, config.covLifetime);
                ok++;
            } catch (e) {
                failed++;
                if (failed <= 3) warn(`souscription COV refusée sur ${factId} : ${e.message}`);
            }
        }
        if (failed) warn(`${failed} souscription(s) COV refusée(s) — ces points ne vivront que du rafraîchissement périodique`);
        return { ok, failed };
    }

    /** Filet de sécurité : relit tout, par petits lots. */
    async function refreshAll() {
        if (!connected) return { read: 0 };
        const entries = [...bindings.entries()];
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
        lastError = null;

        const cov = await subscribeAll();
        await refreshAll();

        // Sondage périodique : DÉSACTIVÉ par défaut (refreshMs = 0). Le lien est
    // piloté par les notifications COV, donc au repos il ne circule rien. Le
    // prix à payer : une COV perdue (UDP n'est pas fiable) passe inaperçue
    // jusqu'au prochain changement. C'est ce que `pointStaleAfter` sert à
    // détecter. Mettre refreshMs > 0 rétablit un filet de sécurité RPM.
    if (config.refreshMs > 0) {
        refreshTimer = setInterval(() => { refreshAll().catch(() => {}); }, config.refreshMs);
    }
        // Les souscriptions COV expirent : on les renouvelle à mi-vie.
        renewTimer = setInterval(() => { subscribeAll().catch(() => {}); }, config.covLifetime * 500);

        return { ...status(), browse: result, cov, objects: objects.length };
    }

    function disconnect() {
        if (refreshTimer) clearInterval(refreshTimer);
        if (renewTimer) clearInterval(renewTimer);
        refreshTimer = renewTimer = null;
        if (client) { try { client.close(); } catch (e) { /* déjà fermé */ } }
        client = null;
        connected = false;
        bindings.clear();
        byObject.clear();
        lastSeen.clear();
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
            lastError,
        };
    }

    // ─── contrat de pilote ───────────────────────────────────────────────────

    return {
        name: 'bacnet',
        config,
        connect, disconnect, browse, refreshAll, status,
        bindings,

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
