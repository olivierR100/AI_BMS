'use strict';
/*
 * bms-core — le cœur du BMS, hors du nœud function.
 *
 * Chargé par settings.js dans functionGlobalContext sous la clé `bmsCore`, et
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
    installCov:       require('./cov'),
    installBms:       require('./bms'),
    installRestore:   require('./restore'),
    installTools:     require('./tools'),
    installProviders: require('./providers'),
    installLogging:   require('./logging'),
    installPrompt:    require('./prompt'),

    // Physique du bâtiment simulé — partagée avec le serveur BACnet de test,
    // pour qu'il n'existe qu'un seul modèle physique.
    runPhysicsTick:   require('../bacnet-sim/physics').runPhysicsTick,

    // Pilote BACnet/IP, instancié à la demande depuis l'API : tant que personne
    // ne se connecte, aucune socket UDP n'est ouverte.
    createBacnetDriver: require('./drivers/bacnet').createBacnetDriver,

    /** Séquence complète d'amorçage. Renvoie les tables de points. */
    installAll(ctx) {
        const tables = this.installPoints(ctx);
        // Profils COV après les tables (il lit les unités et les étiquettes),
        // avant le pilote BACnet, qui les résout à la connexion.
        this.installCov(ctx);
        this.installBms(ctx);
        this.installRestore(ctx);
        this.installTools(ctx);
        this.installProviders(ctx);
        this.installLogging(ctx);
        this.installPrompt(ctx);
        return tables;
    },
};
