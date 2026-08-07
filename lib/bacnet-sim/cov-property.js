'use strict';
/*
 * Côté SERVEUR : traitement de SubscribeCOVProperty.
 *
 * `@bacnet-js/device` répond « service non supporté » à cette requête (son
 * `#onBacnetSubscribeProperty` renvoie directement une erreur). Le simulateur
 * doit pourtant l'accepter : c'est le service par lequel un superviseur règle
 * son propre incrément, et sans lui l'interface du BMS n'aurait rien à proposer.
 *
 * Ce module tient donc sa propre table d'abonnements, à côté de celle de la
 * bibliothèque :
 *
 *   clé          = adresse du client + subscriberProcessIdentifier
 *                  + objet surveillé + propriété surveillée
 *   contenu      = incrément, durée de vie, mode de notification,
 *                  et une VALEUR DE RÉFÉRENCE propre à cet abonnement
 *
 * La référence par abonnement est tout l'intérêt : deux superviseurs peuvent
 * suivre le même capteur avec des seuils différents, chacun avec son propre
 * point de comparaison. Une bande morte posée sur la propriété `COV_Increment`
 * de l'objet ne sait pas faire cela — elle vaut pour tout le monde à la fois.
 *
 * Coexistence : les abonnements SubscribeCOV simples continuent d'être traités
 * par la bibliothèque, avec la bande morte de l'objet. Les deux mécanismes
 * tournent en parallèle sans se gêner, exactement comme sur un automate réel.
 */

/** Un abonnement sans durée de vie n'expire pas (lifetime = 0, cf. norme). */
const NO_EXPIRY = 0;

function installCovProperty({ client, device, deviceId, objects, constants, log = () => {} }) {
    const { PropertyIdentifier, ApplicationTag, BinaryPV, ErrorClass, ErrorCode,
            ServicesSupported, ServicesSupportedBitString } = constants;

    /** clé → abonnement */
    const subs = new Map();
    let received = 0, sent = 0, refused = 0;

    const addrOf = (sender) => (sender && (sender.address || sender.ip || JSON.stringify(sender))) || 'inconnu';
    const keyOf = (sender, pid, objectId, propertyId) =>
        `${addrOf(sender)}|${pid}|${objectId.type}:${objectId.instance}|${propertyId}`;

    /** Retrouve l'entrée `objects` (factId → {object, isBool}) d'un objectId. */
    function findObject(objectId) {
        for (const [factId, entry] of objects) {
            const id = entry.object.identifier.value;
            if (id.type === objectId.type && id.instance === objectId.instance) {
                return { factId, ...entry };
            }
        }
        return null;
    }

    function valueOf(entry) {
        const raw = entry.object.presentValue.getValue();
        return entry.isBool ? raw : Math.round(raw * 10) / 10;
    }

    /** Incrément posé sur l'objet — le repli quand la requête n'en porte pas. */
    function objectIncrement(entry) {
        if (entry.isBool || !entry.object.covIncrement) return 0;
        return entry.object.covIncrement.getValue() || 0;
    }

    function notify(sub, value) {
        const values = [{
            property: { id: sub.propertyId },
            value: [sub.isBool
                ? { type: ApplicationTag.ENUMERATED, value: value ? BinaryPV.ACTIVE : BinaryPV.INACTIVE }
                : { type: ApplicationTag.REAL, value }],
        }];
        const remaining = sub.expiresAt === NO_EXPIRY
            ? 0
            : Math.max(0, Math.round((sub.expiresAt - Date.now()) / 1000));
        try {
            if (sub.confirmed) {
                // L'acquittement du client ne nous intéresse pas ici : le
                // simulateur n'a pas de file de réémission.
                client.confirmedCOVNotification(sub.sender, sub.objectId, sub.pid, deviceId, remaining, values)
                    .catch(() => {});
            } else {
                client.unconfirmedCOVNotification(sub.sender, sub.pid, deviceId, sub.objectId, remaining, values);
            }
            sent++;
        } catch (e) {
            log(`notification COV impossible vers ${addrOf(sub.sender)} : ${e.message}`);
        }
        sub.reference = value;
        sub.lastSent = Date.now();
    }

    // ─── réception de la requête ─────────────────────────────────────────────

    function onSubscribeProperty(req) {
        const { header, service, invokeId, payload } = req;
        received++;
        const sender = header && header.sender;

        const objectId = payload.monitoredObjectIdentifier || payload.monitoredObjectId;
        const monitored = payload.monitoredProperty || {};
        const propertyId = monitored.id;

        const entry = objectId ? findObject(objectId) : null;
        const fail = (cls, code, why) => {
            refused++;
            log(`SubscribeCOVProperty refusé (${why})`);
            if (header && header.expectingReply) client.errorResponse(sender, service, invokeId, cls, code);
        };

        if (!entry) return fail(ErrorClass.OBJECT, ErrorCode.UNKNOWN_OBJECT, 'objet inconnu');
        if (propertyId !== PropertyIdentifier.PRESENT_VALUE) {
            // Seule Present_Value est surveillable ici, et c'est la seule que le
            // BMS demande. Refuser explicitement vaut mieux qu'accepter un
            // abonnement qui ne notifierait jamais.
            return fail(ErrorClass.PROPERTY, ErrorCode.OPTIONAL_FUNCTIONALITY_NOT_SUPPORTED,
                        'seule present-value est surveillable');
        }

        const key = keyOf(sender, payload.subscriberProcessId, objectId, propertyId);

        // Annulation : requête sans les champs de notification (cf. norme).
        if (payload.cancellationRequest) {
            subs.delete(key);
            client.simpleAckResponse(sender, service, invokeId);
            return;
        }

        /*
         * Le décodeur de la bibliothèque rend `covIncrement: 0` aussi bien pour
         * « étiquette 5 absente » que pour « incrément explicitement nul » : la
         * distinction est perdue avant nous. On tranche comme la norme le fait
         * quand l'incrément est absent — repli sur le `COV_Increment` de l'objet —
         * et pour un binaire, où l'incrément n'a pas de sens, toute transition
         * notifie.
         */
        const asked = payload.covIncrement;
        const increment = entry.isBool ? 0
                        : (asked > 0 ? asked : objectIncrement(entry));

        const lifetime = payload.lifetime > 0 ? payload.lifetime : NO_EXPIRY;
        const existing = subs.get(key);
        const sub = {
            key, sender, pid: payload.subscriberProcessId,
            objectId, propertyId, factId: entry.factId, isBool: entry.isBool,
            increment,
            confirmed: !!payload.issueConfirmedNotifications,
            expiresAt: lifetime === NO_EXPIRY ? NO_EXPIRY : Date.now() + lifetime * 1000,
            lifetime,
            // Un renouvellement garde sa référence : la remettre à la valeur
            // courante ferait sauter un franchissement de seuil en cours.
            reference: existing ? existing.reference : null,
            lastSent: existing ? existing.lastSent : null,
        };
        subs.set(key, sub);
        client.simpleAckResponse(sender, service, invokeId);

        // Notification initiale sur un abonnement NEUF seulement : c'est ce qui
        // donne au client sa valeur de départ. Un renouvellement n'en émet pas,
        // sinon renouveler serait un moyen de contourner la bande morte.
        if (!existing) notify(sub, valueOf(entry));
    }

    // La bibliothèque a posé son propre refus ; il doit partir, sinon la même
    // requête recevrait un acquittement ET une erreur.
    const before = client.listenerCount('subscribeProperty');
    client.removeAllListeners('subscribeProperty');
    client.on('subscribeProperty', (req) => {
        try { onSubscribeProperty(req); } catch (e) { log('SubscribeCOVProperty : ' + e.message); }
    });

    /*
     * Annoncer le service dans Protocol_Services_Supported. Sans cela un client
     * conforme n'a aucune raison de l'essayer — et c'est justement ce que le BMS
     * lit pour décider s'il affiche ou masque les réglages d'incrément.
     */
    const advertised = [
        ServicesSupported.WHO_IS, ServicesSupported.I_AM,
        ServicesSupported.READ_PROPERTY, ServicesSupported.READ_PROPERTY_MULTIPLE,
        ServicesSupported.WRITE_PROPERTY,
        ServicesSupported.SUBSCRIBE_COV, ServicesSupported.SUBSCRIBE_COV_PROPERTY,
        ServicesSupported.CONFIRMED_COV_NOTIFICATION,
        ServicesSupported.UNCONFIRMED_COV_NOTIFICATION,
    ];
    device.protocolServicesSupported.setValue(new ServicesSupportedBitString(...advertised));

    return {
        subscriptions: subs,
        replacedListeners: before,

        /**
         * Appelé à chaque changement de valeur d'un point. Évalue la bande morte
         * de CHAQUE abonnement séparément — c'est là que vit la sémantique
         * par abonnement.
         */
        publish(factId, value) {
            const now = Date.now();
            for (const sub of subs.values()) {
                if (sub.factId !== factId) continue;
                if (sub.expiresAt !== NO_EXPIRY && sub.expiresAt <= now) { subs.delete(sub.key); continue; }
                if (sub.reference === null) { notify(sub, value); continue; }
                if (sub.isBool) {
                    if (value !== sub.reference) notify(sub, value);
                } else if (Math.abs(value - sub.reference) >= sub.increment) {
                    notify(sub, value);
                }
            }
        },

        /** Retire les abonnements périmés. */
        sweepExpired() {
            const now = Date.now();
            let dropped = 0;
            for (const sub of [...subs.values()]) {
                if (sub.expiresAt !== NO_EXPIRY && sub.expiresAt <= now) { subs.delete(sub.key); dropped++; }
            }
            return dropped;
        },

        stats() {
            return {
                active: subs.size, received, sent, refused,
                byPoint: [...subs.values()].reduce((acc, s) => {
                    acc[s.factId] = (acc[s.factId] || 0) + 1;
                    return acc;
                }, {}),
            };
        },
    };
}

module.exports = { installCovProperty, NO_EXPIRY };
