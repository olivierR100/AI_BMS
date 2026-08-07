'use strict';
/*
 * Patch — l'interface se conforme à ce que l'appareil sait faire.
 *
 * L'incrément COV se règle par SubscribeCOVProperty, service facultatif. Un
 * appareil qui ne l'annonce pas dans `Protocol_Services_Supported` ne peut
 * recevoir aucun réglage d'incrément : afficher des commandes qui n'auront aucun
 * effet serait pire que ne rien afficher.
 *
 * Le pilote publie donc `capabilities` (lu à la connexion), l'API le relaie, et
 * les deux interfaces masquent ce qui n'est pas utilisable en disant pourquoi.
 *
 * Ce qui reste visible dans tous les cas : le plafond de cadence et le battement
 * de cœur (appliqués côté BMS, indépendants de l'appareil) et la colonne
 * notif/min (une mesure, pas un réglage).
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─────────────────────────────────────────────────────────────────────────────
// 1. API : relayer les capacités de l'appareil
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInFunc(flows, 'API: cov',
    `        defaultProfileName: cov.DEFAULT_PROFILE_NAME,
        knownTags: [...tags].sort(),
        connected: !!live,`,
    `        defaultProfileName: cov.DEFAULT_PROFILE_NAME,
        knownTags: [...tags].sort(),
        connected: !!live,
        // Ce que l'appareil annonce savoir faire. \`covIncrementSettable\` est la
        // seule chose que l'interface doit regarder pour décider d'afficher ou
        // de masquer les réglages d'incrément.
        capabilities: live ? driver.capabilities() : {
            subscribeCovProperty: false, subscribeCovPropertyMultiple: false,
            covIncrementSettable: false, reason: 'aucun serveur BACnet connecté'
        },`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Page « CoV Profiles » : bandeau d'explication et masquage
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-section">Default profile — the floor under every point</div>`,
    `        <div v-if="!settable" class="cv-unsupported">
            <strong>Increments cannot be set on this point source.</strong>
            <div class="cv-why">{{ capabilities.reason }}</div>
            <p>
                An increment travels inside the subscription request, as
                <code>SubscribeCOVProperty</code>. That service is optional: a controller that
                does not announce it in <code>Protocol_Services_Supported</code> keeps whatever
                deadband its own objects carry, and there is nothing for the BMS to set. The
                controls below are hidden rather than shown doing nothing.
            </p>
            <p>
                The BMS-side limits still apply — they are enforced in the driver, not in the
                device, so they work against any point source.
            </p>
        </div>

        <div v-if="settable" class="cv-section">Default profile — the floor under every point</div>`);

// Les éditeurs d'incrément : uniquement si l'appareil peut les recevoir.
fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-units">`,
    `        <div v-if="settable" class="cv-units">`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-hint">
            The increment is written into each device's BACnet <code>COV_Increment</code>, so the
            device stops sending. The rate cap and heartbeat have no BACnet representation and are
            enforced by the BMS driver: the cap delays (never drops) a chatty point, the heartbeat
            re-reads a point that has gone silent, which is what tells “nothing moved” apart from
            “the link is dead”.
        </div>`,
    `        <div class="cv-hint">
            <span v-if="settable">
                The increment travels in the subscription request
                (<code>SubscribeCOVProperty</code>), so the device keeps a reference value for
                <em>our</em> subscription alone — another supervisor watching the same point at a
                different threshold is unaffected.
            </span>
            The rate cap and heartbeat have no BACnet representation and are enforced by the BMS
            driver: the cap delays (never drops) a chatty point, the heartbeat re-reads a point
            that has gone silent, which is what tells “nothing moved” apart from “the link is
            dead”.
        </div>`);

// Profils nommés, création, affectations : tout cela ne sert qu'à porter des
// incréments. Sans service, l'ensemble disparaît.
fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-section">Named profiles</div>`,
    `        <div v-if="settable" class="cv-section">Named profiles</div>`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <table class="cv-table" v-if="namedProfiles.length">`,
    `        <table class="cv-table" v-if="settable && namedProfiles.length">`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div v-else class="cv-hint">No named profile yet — every point uses the default.</div>

        <div class="cv-new">`,
    `        <div v-else-if="settable" class="cv-hint">No named profile yet — every point uses the default.</div>

        <div v-if="settable" class="cv-new">`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-row">
            <label>Rate cap (ms)</label>
            <input type="number" min="0" step="500" v-model.number="draft.minIntervalMs" />
            <label>Heartbeat (ms)</label>
            <input type="number" min="0" step="1000" v-model.number="draft.heartbeatMs" />
            <v-btn size="small" color="primary" :disabled="!draft.name.trim()" @click="createProfile">Create profile</v-btn>
        </div>
        <div class="cv-hint">Leave a unit blank to make the profile transparent for that unit.</div>

        <div class="cv-section">Tag assignments — the main mechanism</div>
        <div class="cv-hint">`,
    `        <div v-if="settable" class="cv-row">
            <label>Rate cap (ms)</label>
            <input type="number" min="0" step="500" v-model.number="draft.minIntervalMs" />
            <label>Heartbeat (ms)</label>
            <input type="number" min="0" step="1000" v-model.number="draft.heartbeatMs" />
            <v-btn size="small" color="primary" :disabled="!draft.name.trim()" @click="createProfile">Create profile</v-btn>
        </div>
        <div v-if="settable" class="cv-hint">Leave a unit blank to make the profile transparent for that unit.</div>

        <div v-if="settable" class="cv-section">Tag assignments — the main mechanism</div>
        <div v-if="settable" class="cv-hint">`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <table class="cv-table" v-if="assignments.length">`,
    `        <table class="cv-table" v-if="settable && assignments.length">`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-row">
            <select v-model="newAssign.tag" class="cv-select">`,
    `        <div v-if="settable" class="cv-row">
            <select v-model="newAssign.tag" class="cv-select">`);

// Compteurs : « pas encore dans l'appareil » n'a de sens que si l'appareil peut
// recevoir le réglage.
fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `            <div class="cv-metric"><span>{{ summary.pending }}</span> not yet in the device</div>`,
    `            <div v-if="settable" class="cv-metric"><span>{{ summary.pending }}</span> not yet in the subscription</div>`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div class="cv-row">
            <v-btn size="small" variant="outlined" :loading="busy" :disabled="!state.connected" @click="pushAll">
                Rewrite every COV_Increment
            </v-btn>
            <span class="cv-hint" v-if="!state.connected">Connect a point source above first.</span>
        </div>`,
    `        <div class="cv-row">
            <v-btn v-if="settable" size="small" variant="outlined" :loading="busy"
                   :disabled="!state.connected" @click="pushAll">
                Re-subscribe every point
            </v-btn>
            <span class="cv-hint" v-if="!state.connected">Connect a point source above first.</span>
        </div>`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `            units() { return this.state.units || []; },`,
    `            capabilities() {
                return this.state.capabilities ||
                    { covIncrementSettable: false, reason: 'not read yet' };
            },
            settable() { return !!this.capabilities.covIncrementSettable; },
            units() { return this.state.units || []; },`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `    .cv-feedback.bad { color: rgb(var(--v-theme-error)); }`,
    `    .cv-feedback.bad { color: rgb(var(--v-theme-error)); }
    .cv-unsupported { margin: 14px 0 4px; padding: 12px 14px; border-radius: 8px;
                      background: rgba(var(--v-theme-warning), 0.10);
                      border: 1px solid rgba(var(--v-theme-warning), 0.35);
                      font-size: 0.85rem; line-height: 1.55; }
    .cv-unsupported p { margin: 8px 0 0; opacity: 0.85; }
    .cv-why { font-family: ui-monospace, monospace; font-size: 0.78rem; opacity: 0.75; margin-top: 4px; }`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Device & Tag Manager : colonne et application en masse conditionnelles
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInTemplate(flows, 'device_manager_ui',
    `        <v-btn size="small" variant="outlined" color="primary" class="ml-2"
               :disabled="!covProfileNames.length" @click="openBulk">`,
    `        <v-btn v-if="covSettable" size="small" variant="outlined" color="primary" class="ml-2"
               :disabled="!covProfileNames.length" @click="openBulk">`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <th style="width: 150px;">CoV increment</th>`,
    `                        <th v-if="covSettable" style="width: 150px;">CoV increment</th>`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <td class="cov-cell">`,
    `                        <td v-if="covSettable" class="cov-cell">`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <td colspan="10" class="text-center text-grey pa-4">`,
    `                        <td :colspan="covSettable ? 10 : 9" class="text-center text-grey pa-4">`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `        covOverrides() { return this.cov.overrides || {}; },`,
    `        covOverrides() { return this.cov.overrides || {}; },
        // Régler un incrément suppose SubscribeCOVProperty sur l'appareil.
        // Sinon la colonne et l'application en masse n'auraient aucun effet.
        covSettable() {
            return !!(this.cov.capabilities && this.cov.capabilities.covIncrementSettable);
        },`);

fk.save(flows);
console.log('gardes de capacité COV —', fk.summary(flows).nodes, 'nœuds');
