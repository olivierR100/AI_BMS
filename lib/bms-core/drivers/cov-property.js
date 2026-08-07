'use strict';
/*
 * SubscribeCOVProperty — l'incrément par ABONNEMENT.
 *
 * C'est le bon mécanisme pour régler le volume de notifications : l'incrément
 * voyage dans la requête d'abonnement, le serveur le range dans son
 * enregistrement avec une valeur de référence PROPRE À CE CLIENT, et deux
 * clients peuvent surveiller le même point avec des seuils différents.
 *
 *   SubscribeCOVProperty {
 *     subscriberProcessIdentifier: 42,
 *     monitoredObjectIdentifier:   (analog-input, 12),
 *     monitoredPropertyIdentifier: present-value,
 *     issueConfirmedNotifications: false,
 *     lifetime:                    300,
 *     covIncrement:                0.5        ← étiquette 5, facultative
 *   }
 *
 * À comparer avec l'écriture de la propriété `COV_Increment` de l'objet, qui
 * modifie la bande morte pour TOUS les abonnés de l'appareil — un effet de bord
 * sur les autres superviseurs, et pas un réglage du BMS.
 *
 * ─── Pourquoi ce fichier existe ─────────────────────────────────────────────
 *
 * `@bacnet-js/client` sait encoder ET décoder l'incrément (`SubscribeProperty`,
 * étiquette de contexte 5). C'est son enveloppe `client.subscribeProperty()` qui
 * le jette : elle appelle l'encodeur avec `covIncrementPresent = false`, et
 * ignore au passage l'argument `lifetime` qu'on lui donne (elle encode 0).
 *
 * On ne réimplémente donc pas la requête — ce serait recopier la gestion des
 * identifiants d'invocation, des tampons et des acquittements. On substitue
 * l'encodeur de la bibliothèque le temps d'un appel, avec les deux arguments
 * qu'elle refuse de transmettre. Un seul point de contact, et c'est l'encodeur
 * de la bibliothèque qui écrit les octets.
 *
 * Fragilité assumée : une montée de version de `@bacnet-js/client` qui change la
 * signature de `SubscribeProperty.encode` casse ce fichier. Le garde-fou est le
 * contrôle d'arité ci-dessous, qui échoue bruyamment plutôt que d'envoyer une
 * trame silencieusement fausse.
 */

const ASN1_ARRAY_ALL = 0xFFFFFFFF;

let SubscribeProperty = null;
function service() {
    if (SubscribeProperty) return SubscribeProperty;
    // Import profond : le paquet n'expose pas ses services, et l'enveloppe
    // publique est précisément celle qui perd l'incrément.
    const mod = require('@bacnet-js/client/dist/lib/services/SubscribeProperty');
    SubscribeProperty = mod.default || mod;
    if (typeof SubscribeProperty.encode !== 'function' || SubscribeProperty.encode.length !== 9) {
        throw new Error(
            'SubscribeProperty.encode a changé de signature (arité ' +
            SubscribeProperty.encode.length + ', 9 attendue) — ' +
            "le réglage d'incrément par abonnement doit être revérifié");
    }
    return SubscribeProperty;
}

/** Vrai si la bibliothèque permet encore de poser l'incrément. */
function isAvailable() {
    try { service(); return true; } catch (e) { return false; }
}

let inFlight = false;

/**
 * Envoie un SubscribeCOVProperty en portant l'incrément et la durée de vie.
 *
 * @param {object} client            instance @bacnet-js/client
 * @param {object} target            { address: 'host:port' }
 * @param {object} objectId          { type, instance }
 * @param {number} propertyId        PropertyIdentifier.PRESENT_VALUE
 * @param {number} processId         identifiant de processus abonné, STABLE par
 *                                   point : le serveur s'en sert comme clé, donc
 *                                   ré-émettre met à jour au lieu de dupliquer.
 * @param {object} opts
 * @param {number|null} opts.increment  incrément ; null/undefined = absent de la
 *                                   requête, le serveur retombe alors sur le
 *                                   `COV_Increment` de l'objet.
 * @param {number} opts.lifetime     secondes ; 0 = sans expiration.
 * @param {boolean} opts.confirmed   notifications confirmées.
 * @param {boolean} opts.cancel      annulation de l'abonnement.
 */
async function subscribeCovProperty(client, target, objectId, propertyId, processId, opts = {}) {
    const svc = service();
    const { increment = null, lifetime = 0, confirmed = false, cancel = false } = opts;
    const hasIncrement = typeof increment === 'number' && Number.isFinite(increment);

    // La substitution est globale au module le temps de l'appel. Les appels du
    // pilote sont sérialisés (cf. la note sur `_segmentStore`), mais un
    // enchevêtrement enverrait l'incrément d'un point sur un autre : mieux vaut
    // refuser que mentir.
    if (inFlight) throw new Error('subscribeCovProperty n’est pas réentrant');
    inFlight = true;

    const original = svc.encode;
    svc.encode = function patched(buffer, pid, oid, cancellationRequest, issueConfirmed, _lifetime, prop) {
        return original.call(svc, buffer, pid, oid, cancellationRequest, issueConfirmed,
                            lifetime, prop, hasIncrement, hasIncrement ? increment : 0);
    };
    try {
        await client.subscribeProperty(target, objectId,
            { id: propertyId, index: ASN1_ARRAY_ALL }, processId, cancel, confirmed);
    } finally {
        svc.encode = original;
        inFlight = false;
    }
}

module.exports = { subscribeCovProperty, isAvailable, ASN1_ARRAY_ALL };
