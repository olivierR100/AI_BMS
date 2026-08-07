'use strict';
/*
 * Patch — profils COV (§ 2 de la feuille de route).
 *
 * Trois ajouts :
 *   1. `GET/POST /bms/cov` — lecture et édition des profils, des affectations
 *      par étiquette et des surcharges par point. Toute écriture repousse les
 *      incréments dans l'appareil (propriété BACnet `COV_Increment`).
 *   2. Page BACnet Server : section « CoV profiles ».
 *   3. Device & Tag Manager : colonne « incrément effectif + provenance »,
 *      colonne « notif/min » triable, et application en masse aux appareils
 *      visibles avec confirmation à deux nombres.
 *
 * La logique vit dans lib/bms-core/cov.js ; ces nœuds ne font que l'exposer.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─────────────────────────────────────────────────────────────────────────────
// 1. API
// ─────────────────────────────────────────────────────────────────────────────

const apiFunc = `// Optional auth: if BMS_API_TOKEN env var is set on the Node-RED process,
// require it in the x-bms-token header (endpoints are otherwise open like the dashboard)
const required = env.get('BMS_API_TOKEN');
if (required && (!msg.req || msg.req.headers['x-bms-token'] !== required)) {
    msg.statusCode = 401;
    msg.payload = { error: 'unauthorized' };
    return msg;
}

const cov = global.get('covPolicy');
const io = global.get('ioDrivers');
if (!cov) {
    msg.statusCode = 503;
    msg.payload = { error: 'BMS not initialised' };
    return msg;
}

const driver = (io && io.driverOrNull) ? io.driverOrNull('bacnet') : null;
const live = driver && driver.status().connected;

/**
 * État complet : profils, règles d'affectation, et pour chaque point
 * l'incrément EFFECTIF avec sa provenance. Sans la provenance, personne ne peut
 * expliquer pourquoi un point se comporte autrement que son voisin.
 */
function state() {
    const rates = live ? driver.rates() : {};
    const effective = cov.resolveAll();
    const out = {};
    for (const [id, r] of Object.entries(effective)) {
        out[id] = {
            unit: r.unit,
            increment: r.increment,
            minIntervalMs: r.minIntervalMs,
            heartbeatMs: r.heartbeatMs,
            source: r.source,
            profile: r.profile,
            // Incrément réellement posé dans l'appareil. Différent de
            // l'effectif = le réglage n'a pas encore été poussé, ou l'appareil
            // l'a refusé : dans les deux cas la bande morte est celle de
            // l'appareil, pas celle du BMS.
            applied: live ? driver.appliedIncrement(id) : null,
            notifPerMin: rates[id] === undefined ? null : rates[id]
        };
    }
    // Étiquettes connues, pour la liste d'affectation : moins cher que de faire
    // charger /bms/context (points + configuration complète) au widget.
    const tags = new Set();
    Object.values(global.get('bmsMetadata') || {}).forEach(m => (m.tags || []).forEach(t => tags.add(t)));

    return {
        profiles: cov.profiles(),
        assignments: cov.assignments(),
        overrides: cov.overrides(),
        unitDefaults: cov.UNIT_DEFAULTS,
        units: cov.UNITS,
        defaultProfileName: cov.DEFAULT_PROFILE_NAME,
        knownTags: [...tags].sort(),
        connected: !!live,
        rateWindowMin: 60,
        points: out
    };
}

/** Repousse les incréments vers l'appareil après toute édition. */
function pushAndRespond(extra) {
    if (!live) {
        msg.payload = Object.assign(state(), extra, { pushed: null });
        return msg;
    }
    return driver.applyCovPolicy().then(res => {
        msg.payload = Object.assign(state(), extra, { pushed: res });
        return msg;
    }).catch(e => {
        msg.payload = Object.assign(state(), extra, { pushed: { error: e.message } });
        return msg;
    });
}

const method = ((msg.req && msg.req.method) || 'GET').toUpperCase();

if (method === 'GET') {
    msg.payload = state();
    return msg;
}

const body = msg.payload || {};
const action = body.action;

try {
    switch (action) {
        case 'setProfile': {
            const r = cov.setProfile(body.profile);
            return pushAndRespond({ saved: r.profile.name, warnings: r.warnings });
        }
        case 'deleteProfile': {
            const r = cov.deleteProfile(body.name);
            return pushAndRespond({ deleted: r.deleted, overridesDropped: r.overridesDropped });
        }
        case 'setAssignments': {
            const r = cov.setAssignments(body.assignments);
            return pushAndRespond({ assignments: r.assignments, warnings: r.warnings });
        }
        case 'setOverride': {
            const r = cov.setOverride(body.pointId, body.profile === undefined ? null : body.profile);
            return pushAndRespond({ resolved: r });
        }
        // Les deux nombres de la confirmation, sans rien modifier.
        case 'preview': {
            msg.payload = Object.assign(state(), { preview: cov.preview(body.profile, body.pointIds || []) });
            return msg;
        }
        case 'applyToPoints': {
            const r = cov.applyToPoints(body.profile, body.pointIds || [], { overwriteManual: !!body.overwriteManual });
            return pushAndRespond({ applied: r });
        }
        // Réécrit tous les incréments dans l'appareil, même inchangés.
        case 'push': {
            if (!live) {
                msg.statusCode = 409;
                msg.payload = { error: 'aucun serveur BACnet connecté' };
                return msg;
            }
            return driver.applyCovPolicy({ force: true }).then(res => {
                msg.payload = Object.assign(state(), { pushed: res });
                return msg;
            });
        }
        default:
            msg.statusCode = 400;
            msg.payload = { error: "action attendue : setProfile | deleteProfile | setAssignments | setOverride | preview | applyToPoints | push" };
            return msg;
    }
} catch (e) {
    msg.statusCode = 400;
    msg.payload = { error: e.message };
    return msg;
}`;

fk.addNodes(flows, [
    {
        id: 'bms_api_in_cov_get', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'GET /bms/cov', url: '/bms/cov', method: 'get', upload: false, swaggerDoc: '',
        x: 190, y: 1870, wires: [['bms_api_fn_cov']],
    },
    {
        id: 'bms_api_in_cov_post', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'POST /bms/cov', url: '/bms/cov', method: 'post', upload: false, swaggerDoc: '',
        x: 190, y: 1910, wires: [['bms_api_fn_cov']],
    },
    {
        id: 'bms_api_fn_cov', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'API: cov', func: apiFunc, outputs: 1, timeout: 0, noerr: 0,
        initialize: '', finalize: '', libs: [],
        x: 470, y: 1890, wires: [['bms_api_response']],
    },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Page BACnet Server — section « CoV profiles »
// ─────────────────────────────────────────────────────────────────────────────

const covUi = `<template>
    <div class="cv">
        <p class="cv-intro">
            A profile is a <strong>sparse</strong> table of unit → increment, not a single
            number. A named profile only affects a point whose unit it defines — applying
            “CO2 fine” to a mixed selection touches the ppm points and leaves the rest alone.
            Precedence: <em>per-point override → tag assignment → default</em>.
        </p>

        <div class="cv-section">Default profile — the floor under every point</div>
        <div class="cv-units">
            <div v-for="u in units" :key="u" class="cv-unit">
                <label>{{ u === 'bool' ? 'boolean' : u }}</label>
                <input v-if="u !== 'bool'" type="number" step="0.1" min="0"
                       v-model.number="base.increments[u]" @change="saveBase" />
                <span v-else class="cv-any">every transition</span>
            </div>
        </div>
        <div class="cv-row">
            <label>Rate cap (ms)</label>
            <input type="number" min="0" step="500" v-model.number="base.minIntervalMs" @change="saveBase" />
            <label>Heartbeat (ms)</label>
            <input type="number" min="0" step="1000" v-model.number="base.heartbeatMs" @change="saveBase" />
        </div>
        <div class="cv-hint">
            The increment is written into each device's BACnet <code>COV_Increment</code>, so the
            device stops sending. The rate cap and heartbeat have no BACnet representation and are
            enforced by the BMS driver: the cap delays (never drops) a chatty point, the heartbeat
            re-reads a point that has gone silent, which is what tells “nothing moved” apart from
            “the link is dead”.
        </div>

        <div class="cv-section">Named profiles</div>
        <table class="cv-table" v-if="namedProfiles.length">
            <thead><tr><th>Name</th><th>Increments</th><th>Rate cap</th><th>Heartbeat</th><th>Points</th><th></th></tr></thead>
            <tbody>
                <tr v-for="p in namedProfiles" :key="p.name">
                    <td class="cv-mono">{{ p.name }}</td>
                    <td>{{ describeIncrements(p) }}</td>
                    <td>{{ p.minIntervalMs ? p.minIntervalMs + ' ms' : '—' }}</td>
                    <td>{{ p.heartbeatMs ? p.heartbeatMs + ' ms' : '—' }}</td>
                    <td>{{ usageCount(p.name) }}</td>
                    <td><v-btn size="x-small" variant="text" color="error" @click="removeProfile(p.name)">Delete</v-btn></td>
                </tr>
            </tbody>
        </table>
        <div v-else class="cv-hint">No named profile yet — every point uses the default.</div>

        <div class="cv-new">
            <v-text-field v-model="draft.name" label="Profile name" density="compact" variant="outlined"
                          hide-details class="cv-field" placeholder="CO2 fine" />
            <div v-for="u in numericUnits" :key="'d' + u" class="cv-unit">
                <label>{{ u }}</label>
                <input type="number" step="0.1" min="0" v-model="draft.increments[u]" placeholder="—" />
            </div>
            <div class="cv-unit">
                <label>boolean</label>
                <input type="checkbox" v-model="draft.coversBool" />
            </div>
        </div>
        <div class="cv-row">
            <label>Rate cap (ms)</label>
            <input type="number" min="0" step="500" v-model.number="draft.minIntervalMs" />
            <label>Heartbeat (ms)</label>
            <input type="number" min="0" step="1000" v-model.number="draft.heartbeatMs" />
            <v-btn size="small" color="primary" :disabled="!draft.name.trim()" @click="createProfile">Create profile</v-btn>
        </div>
        <div class="cv-hint">Leave a unit blank to make the profile transparent for that unit.</div>

        <div class="cv-section">Tag assignments — the main mechanism</div>
        <div class="cv-hint">
            Evaluated top to bottom, first match wins. A new point carrying the tag inherits the
            profile with no further action, which is why this beats applying profiles by hand.
        </div>
        <table class="cv-table" v-if="assignments.length">
            <tbody>
                <tr v-for="(a, i) in assignments" :key="a.tag">
                    <td style="width: 40px;">{{ i + 1 }}</td>
                    <td class="cv-mono">{{ a.tag }}</td>
                    <td>→ {{ a.profile }}</td>
                    <td style="width: 120px;">
                        <v-btn size="x-small" variant="text" :disabled="i === 0" @click="move(i, -1)">↑</v-btn>
                        <v-btn size="x-small" variant="text" :disabled="i === assignments.length - 1" @click="move(i, 1)">↓</v-btn>
                        <v-btn size="x-small" variant="text" color="error" @click="unassign(i)">✕</v-btn>
                    </td>
                </tr>
            </tbody>
        </table>
        <div class="cv-row">
            <select v-model="newAssign.tag" class="cv-select">
                <option value="">tag…</option>
                <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
            </select>
            <select v-model="newAssign.profile" class="cv-select">
                <option value="">profile…</option>
                <option v-for="p in namedProfiles" :key="p.name" :value="p.name">{{ p.name }}</option>
            </select>
            <v-btn size="small" variant="outlined" :disabled="!newAssign.tag || !newAssign.profile" @click="assign">Assign</v-btn>
        </div>

        <div class="cv-section">Effect right now</div>
        <div class="cv-metrics">
            <div class="cv-metric"><span>{{ summary.notifPerMin }}</span> notifications/min, all points</div>
            <div class="cv-metric"><span>{{ summary.overrides }}</span> per-point overrides</div>
            <div class="cv-metric"><span>{{ summary.pending }}</span> not yet in the device</div>
        </div>
        <div class="cv-row">
            <v-btn size="small" variant="outlined" :loading="busy" :disabled="!state.connected" @click="pushAll">
                Rewrite every COV_Increment
            </v-btn>
            <span class="cv-hint" v-if="!state.connected">Connect a point source above first.</span>
        </div>
        <div v-if="feedback" class="cv-feedback" :class="{ bad: feedbackBad }">{{ feedback }}</div>
    </div>
</template>

<script>
    export default {
        data() {
            return {
                state: { profiles: {}, assignments: [], overrides: {}, units: [], points: {},
                         unitDefaults: {}, defaultProfileName: 'default', connected: false },
                base: { name: 'default', increments: {}, minIntervalMs: 0, heartbeatMs: 0 },
                draft: { name: '', increments: {}, coversBool: false, minIntervalMs: 0, heartbeatMs: 0 },
                newAssign: { tag: '', profile: '' },
                busy: false, feedback: '', feedbackBad: false, timer: null
            };
        },
        computed: {
            units() { return this.state.units || []; },
            numericUnits() { return this.units.filter(u => u !== 'bool'); },
            assignments() { return this.state.assignments || []; },
            namedProfiles() {
                return Object.values(this.state.profiles || {})
                    .filter(p => p.name !== this.state.defaultProfileName);
            },
            allTags() { return this.state.knownTags || []; },
            summary() {
                const pts = Object.values(this.state.points || {});
                const rate = pts.reduce((a, p) => a + (p.notifPerMin || 0), 0);
                const pending = pts.filter(p => p.increment !== null && p.unit !== 'bool'
                                             && p.applied !== p.increment).length;
                return {
                    notifPerMin: Math.round(rate * 10) / 10,
                    overrides: Object.keys(this.state.overrides || {}).length,
                    pending
                };
            }
        },
        mounted() {
            this.refresh();
            this.timer = setInterval(this.refresh, 5000);
        },
        unmounted() { if (this.timer) clearInterval(this.timer); },
        methods: {
            async refresh() {
                if (this.busy) return;
                try {
                    const r = await fetch('/bms/cov');
                    if (!r.ok) return;
                    const s = await r.json();
                    this.state = s;
                    const d = s.profiles[s.defaultProfileName];
                    if (d) this.base = JSON.parse(JSON.stringify(d));
                } catch (e) { /* dashboard reload */ }
            },
            describeIncrements(p) {
                const parts = Object.entries(p.increments || {})
                    .map(([u, v]) => (u === 'bool' ? 'every transition' : v + ' ' + u));
                return parts.length ? parts.join(' · ') : 'none — matches nothing';
            },
            usageCount(name) {
                return Object.values(this.state.points || {}).filter(p => p.profile === name).length;
            },
            async post(body, label) {
                this.busy = true; this.feedback = ''; this.feedbackBad = false;
                try {
                    const r = await fetch('/bms/cov', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const payload = await r.json();
                    if (!r.ok) { this.feedback = payload.error || 'Failed.'; this.feedbackBad = true; return null; }
                    this.state = payload;
                    const d = payload.profiles[payload.defaultProfileName];
                    if (d) this.base = JSON.parse(JSON.stringify(d));
                    const warn = (payload.warnings || []).join(' · ');
                    const pushed = payload.pushed && payload.pushed.written !== undefined
                        ? ' — ' + payload.pushed.written + ' increment(s) written to the device'
                        : '';
                    this.feedback = (label || 'Saved') + pushed + (warn ? ' · ' + warn : '');
                    setTimeout(() => { this.feedback = ''; }, 8000);
                    return payload;
                } catch (e) {
                    this.feedback = 'Request failed: ' + e.message; this.feedbackBad = true; return null;
                } finally { this.busy = false; }
            },
            saveBase() { this.post({ action: 'setProfile', profile: this.base }, 'Default profile saved'); },
            createProfile() {
                const increments = {};
                for (const [u, v] of Object.entries(this.draft.increments)) {
                    if (v === '' || v === null || v === undefined) continue;
                    increments[u] = Number(v);
                }
                if (this.draft.coversBool) increments.bool = 0;
                this.post({
                    action: 'setProfile',
                    profile: { name: this.draft.name.trim(), increments,
                               minIntervalMs: this.draft.minIntervalMs || 0,
                               heartbeatMs: this.draft.heartbeatMs || 0 }
                }, 'Profile created').then(ok => {
                    if (ok) this.draft = { name: '', increments: {}, coversBool: false, minIntervalMs: 0, heartbeatMs: 0 };
                });
            },
            removeProfile(name) {
                this.post({ action: 'deleteProfile', name }, 'Profile deleted');
            },
            assign() {
                const list = this.assignments.filter(a => a.tag !== this.newAssign.tag)
                    .concat([{ tag: this.newAssign.tag, profile: this.newAssign.profile }]);
                this.post({ action: 'setAssignments', assignments: list }, 'Assignment added')
                    .then(ok => { if (ok) this.newAssign = { tag: '', profile: '' }; });
            },
            unassign(i) {
                const list = this.assignments.slice();
                list.splice(i, 1);
                this.post({ action: 'setAssignments', assignments: list }, 'Assignment removed');
            },
            move(i, delta) {
                const list = this.assignments.slice();
                const [item] = list.splice(i, 1);
                list.splice(i + delta, 0, item);
                this.post({ action: 'setAssignments', assignments: list }, 'Order changed');
            },
            pushAll() { this.post({ action: 'push' }, 'Increments rewritten'); }
        }
    };
</script>

<style>
    .cv { padding: 4px 2px; font-size: 0.9rem; }
    .cv-intro { margin: 0 0 4px; font-size: 0.85rem; line-height: 1.5; opacity: 0.85; }
    .cv-section { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
                  opacity: 0.65; margin: 20px 0 8px; }
    .cv-hint { font-size: 0.8rem; opacity: 0.72; margin-top: 8px; line-height: 1.5; }
    .cv-units { display: flex; gap: 14px; flex-wrap: wrap; }
    .cv-unit { display: flex; align-items: center; gap: 6px; }
    .cv-unit label { font-size: 0.8rem; opacity: 0.75; min-width: 58px; }
    .cv-unit input[type=number], .cv-row input[type=number] {
        width: 78px; padding: 4px 6px; font-family: ui-monospace, monospace; font-size: 0.82rem;
        border: 1px solid rgba(var(--v-theme-on-surface), 0.25); border-radius: 4px;
        background: transparent; color: rgb(var(--v-theme-on-surface)); }
    .cv-any { font-size: 0.8rem; opacity: 0.6; font-style: italic; }
    .cv-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .cv-row label { font-size: 0.8rem; opacity: 0.75; }
    .cv-new { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .cv-field { max-width: 200px; }
    .cv-select { padding: 5px 8px; font-size: 0.82rem; border-radius: 4px;
                 border: 1px solid rgba(var(--v-theme-on-surface), 0.25);
                 background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-on-surface)); }
    .cv-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-top: 8px; }
    .cv-table th { text-align: left; padding: 6px 8px; opacity: 0.7; font-weight: 500;
                   border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.15); }
    .cv-table td { padding: 5px 8px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.07); }
    .cv-mono { font-family: ui-monospace, monospace; }
    .cv-metrics { display: flex; gap: 24px; flex-wrap: wrap; }
    .cv-metric { font-size: 0.8rem; opacity: 0.75; }
    .cv-metric span { display: block; font-size: 1.4rem; font-weight: 600; opacity: 1;
                      font-variant-numeric: tabular-nums; }
    .cv-feedback { margin-top: 12px; font-size: 0.85rem; }
    .cv-feedback.bad { color: rgb(var(--v-theme-error)); }
</style>`;

// Le panneau capteurs passe en troisième : connexion, puis profils, puis forçage.
const sensorGroup = flows.find((n) => n.type === 'ui-group' && n.page === 'page_simulator'
                                   && n.id !== 'grp_ui_bacnet');
if (!sensorGroup) throw new Error('groupe « Sensor Simulation » introuvable sur la page BACnet');
sensorGroup.order = 2;

fk.addNodes(flows, [
    {
        id: 'grp_ui_cov', type: 'ui-group', name: 'CoV Profiles',
        page: 'page_simulator', width: '10', height: '1', order: 1,
        showTitle: true, className: '', visible: 'true', disabled: 'false',
        groupType: 'default',
    },
    {
        id: 'cov_profiles_ui', type: 'ui-template', z: 'tab_bms_v9',
        group: 'grp_ui_cov', page: '', ui: '', name: 'CoV Profiles UI',
        order: 0, width: '10', height: '22', head: '',
        format: covUi,
        // Réception seule : le widget interroge /bms/cov lui-même.
        storeOutMessages: false, passthru: false, resendOnRefresh: true,
        templateScope: 'local', className: '',
        x: 900, y: 1900, wires: [[]],
    },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Device & Tag Manager — incrément effectif, provenance, notif/min, masse
// ─────────────────────────────────────────────────────────────────────────────

// 3a. Bouton d'application en masse, à côté des compteurs existants.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        <v-spacer></v-spacer>
        <v-chip color="grey" variant="tonal" size="small"><v-icon icon="mdi-refresh" class="mr-1"></v-icon> Auto-refresh 5s</v-chip>
    </div>`,
    `        <v-spacer></v-spacer>
        <v-chip v-if="covTotalRate !== null" color="orange" variant="tonal" size="small">
            <v-icon icon="mdi-bell-ring-outline" class="mr-1"></v-icon> {{ covTotalRate }} notif/min
        </v-chip>
        <v-btn size="small" variant="outlined" color="primary" class="ml-2"
               :disabled="!covProfileNames.length" @click="openBulk">
            <v-icon icon="mdi-tune-variant" class="mr-1"></v-icon> Apply CoV profile to visible
        </v-btn>
        <v-chip color="grey" variant="tonal" size="small" class="ml-2"><v-icon icon="mdi-refresh" class="mr-1"></v-icon> Auto-refresh 5s</v-chip>
    </div>`);

// 3b. Deux colonnes de plus. « notif/min » est triable : trier dessus est la
//     façon concrète de trouver le point mal réglé au milieu de 86.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <th style="width: 90px;">Zone</th>
                        <th>Tags</th>`,
    `                        <th style="width: 90px;">Zone</th>
                        <th style="width: 150px;">CoV increment</th>
                        <th style="width: 95px; cursor: pointer; user-select: none;" @click="toggleRateSort"
                            title="Notifications per minute, measured over a one-hour sliding window">
                            notif/min{{ rateSort === 'desc' ? ' ▼' : rateSort === 'asc' ? ' ▲' : '' }}
                        </th>
                        <th>Tags</th>`);

// 3c. Les deux cellules correspondantes. La provenance est affichée avec
//     l'incrément : sans elle, un point réglé autrement que son voisin est
//     inexplicable.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <td class="text-caption">{{ device.zone }}</td>
                        <td>
                            <div class="d-flex flex-wrap gap-1 align-center">`,
    `                        <td class="text-caption">{{ device.zone }}</td>
                        <td class="cov-cell">
                            <v-menu v-if="device.source === 'bacnet' && covOf(device)">
                                <template v-slot:activator="{ props }">
                                    <span v-bind="props" class="cov-chip" :class="'cov-' + covOf(device).source.split(':')[0]">
                                        {{ covLabel(device) }}
                                    </span>
                                </template>
                                <v-list density="compact" max-height="320">
                                    <v-list-subheader>Per-point override</v-list-subheader>
                                    <v-list-item v-for="p in covProfileNames" :key="p"
                                                 :active="covOverrides[device.id] === p"
                                                 @click="setCovOverride(device.id, p)">
                                        <v-list-item-title>{{ p }}</v-list-item-title>
                                        <v-list-item-subtitle v-if="!covCovers(p, device)">
                                            does not define {{ covOf(device).unit }} — no effect here
                                        </v-list-item-subtitle>
                                    </v-list-item>
                                    <v-divider></v-divider>
                                    <v-list-item :disabled="!covOverrides[device.id]" @click="setCovOverride(device.id, null)">
                                        <v-list-item-title>Clear override</v-list-item-title>
                                    </v-list-item>
                                </v-list>
                            </v-menu>
                            <span v-else class="text-caption text-grey">—</span>
                            <div v-if="covOf(device) && covPending(device)" class="cov-pending"
                                 title="The BMS setting has not reached the device: its own deadband still applies">
                                not in device
                            </div>
                        </td>
                        <td class="value-cell">
                            <span v-if="covOf(device) && covOf(device).notifPerMin !== null">{{ covOf(device).notifPerMin }}</span>
                            <span v-else class="text-grey">—</span>
                        </td>
                        <td>
                            <div class="d-flex flex-wrap gap-1 align-center">`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `<td colspan="8" class="text-center text-grey pa-4">`,
    `<td colspan="10" class="text-center text-grey pa-4">`);

// 3d. La confirmation d'application en masse. DEUX nombres, et une case à cocher
//     pour le seul cas destructeur : écraser des surcharges manuelles.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="2000">{{ snackbar.text }}</v-snackbar>`,
    `    <v-dialog v-model="bulk.show" max-width="560">
        <v-card>
            <v-card-title class="text-subtitle-1">Apply a CoV profile to the visible devices</v-card-title>
            <v-card-text>
                <select v-model="bulk.profile" class="bulk-select" @change="previewBulk">
                    <option value="">choose a profile…</option>
                    <option v-for="p in covProfileNames" :key="p" :value="p">{{ p }}</option>
                </select>
                <div v-if="bulk.preview" class="bulk-body">
                    <p class="bulk-line">
                        Apply <strong>{{ bulk.profile }}</strong> to
                        <strong>{{ bulk.preview.matchingCount }} of {{ bulk.preview.considered }}</strong>
                        visible devices.
                    </p>
                    <p class="bulk-line bulk-muted" v-if="bulk.preview.notMatchingCount">
                        {{ bulk.preview.notMatchingCount }} have no point in a unit this profile
                        defines and are not concerned.
                    </p>
                    <p class="bulk-line bulk-warn" v-if="bulk.preview.manualCount">
                        ⚠ {{ bulk.preview.manualCount }} of the {{ bulk.preview.matchingCount }}
                        already carry a manual override, which would be overwritten.
                    </p>
                    <v-checkbox v-if="bulk.preview.manualCount" v-model="bulk.overwriteManual"
                                density="compact" hide-details
                                :label="'Overwrite the ' + bulk.preview.manualCount + ' manual override(s)'" />
                    <p class="bulk-line bulk-muted" v-if="bulk.preview.manualCount && !bulk.overwriteManual">
                        They will be left untouched: {{ bulk.preview.matchingCount - bulk.preview.manualCount }}
                        device(s) will change.
                    </p>
                </div>
            </v-card-text>
            <v-card-actions>
                <v-spacer></v-spacer>
                <v-btn variant="text" @click="bulk.show = false">Cancel</v-btn>
                <v-btn color="primary" variant="flat" :loading="bulk.busy"
                       :disabled="!bulk.preview || bulk.preview.matchingCount === 0" @click="applyBulk">Apply</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="2000">{{ snackbar.text }}</v-snackbar>`);

// 3e. Styles des nouvelles cellules.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `.bool-false { color: #9e9e9e; }`,
    `.bool-false { color: #9e9e9e; }
.cov-cell { white-space: nowrap; }
.cov-chip { font-size: 11.5px; font-family: 'Roboto Mono', ui-monospace, monospace;
            padding: 2px 6px; border-radius: 4px; cursor: pointer;
            border: 1px solid rgba(0,0,0,0.12); }
.cov-chip:hover { border-color: #1976d2; }
.cov-default { color: #616161; }
.cov-tag { color: #6a1b9a; background: rgba(106,27,154,0.07); }
.cov-manual { color: #e65100; background: rgba(230,81,0,0.08); }
.cov-pending { font-size: 10px; color: #c62828; margin-top: 2px; }
.bulk-select { width: 100%; padding: 8px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; }
.bulk-body { margin-top: 14px; }
.bulk-line { margin: 0 0 6px; font-size: 13.5px; line-height: 1.5; }
.bulk-muted { opacity: 0.7; }
.bulk-warn { color: #e65100; }`);

// 3f. État du composant.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        return { devices: [], allTags: [], selectedTags: [], searchQuery: '', newTagName: '', snackbar: { show: false, text: '', color: 'success' } }`,
    `        return { devices: [], allTags: [], selectedTags: [], searchQuery: '', newTagName: '',
                 snackbar: { show: false, text: '', color: 'success' },
                 cov: { points: {}, profiles: {}, overrides: {}, defaultProfileName: 'default' },
                 rateSort: null, covTimer: null,
                 bulk: { show: false, profile: '', preview: null, overwriteManual: false, busy: false } }`);

// 3g. Tri par notif/min, et raccourcis vers l'état COV.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `            return result;
        }
    },`,
    `            if (this.rateSort) {
                const rate = d => {
                    const c = this.cov.points[d.id];
                    return c && c.notifPerMin !== null ? c.notifPerMin : -1;
                };
                result = result.slice().sort((a, b) => this.rateSort === 'desc'
                    ? rate(b) - rate(a) : rate(a) - rate(b));
            }
            return result;
        },
        covOverrides() { return this.cov.overrides || {}; },
        covProfileNames() {
            return Object.keys(this.cov.profiles || {}).sort();
        },
        covTotalRate() {
            const pts = Object.values(this.cov.points || {});
            if (!pts.length || pts.every(p => p.notifPerMin === null)) return null;
            return Math.round(pts.reduce((a, p) => a + (p.notifPerMin || 0), 0) * 10) / 10;
        }
    },
    mounted() {
        this.fetchCov();
        this.covTimer = setInterval(this.fetchCov, 5000);
    },
    unmounted() { if (this.covTimer) clearInterval(this.covTimer); },`);

// 3h. Méthodes COV.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        showSnackbar(text, color) { this.snackbar = { show: true, text, color }; }`,
    `        showSnackbar(text, color) { this.snackbar = { show: true, text, color }; },
        async fetchCov() {
            try {
                const r = await fetch('/bms/cov');
                if (r.ok) this.cov = await r.json();
            } catch (e) { /* dashboard reload */ }
        },
        covOf(device) { return this.cov.points[device.id] || null; },
        // « 0.2 °C · default », « 10 ppm · tag:meeting », « 1.5 °C · manual ».
        // La provenance fait partie de l'étiquette : sans elle, un point réglé
        // autrement que son voisin est inexplicable.
        covLabel(device) {
            const c = this.covOf(device);
            if (!c) return '—';
            const inc = c.unit === 'bool' ? 'any change'
                      : c.increment === null ? 'unset' : c.increment + ' ' + c.unit;
            return inc + ' · ' + c.source;
        },
        // Le réglage du BMS n'est pas encore (ou pas) dans l'appareil : sa
        // propre bande morte s'applique toujours.
        covPending(device) {
            const c = this.covOf(device);
            return c && c.unit !== 'bool' && c.increment !== null
                && this.cov.connected && c.applied !== c.increment;
        },
        covCovers(profileName, device) {
            const p = this.cov.profiles[profileName];
            const c = this.covOf(device);
            return !!(p && c && p.increments && p.increments[c.unit] !== undefined);
        },
        async postCov(body) {
            const r = await fetch('/bms/cov', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const payload = await r.json();
            if (!r.ok) { this.showSnackbar(payload.error || 'CoV update failed', 'error'); return null; }
            return payload;
        },
        async setCovOverride(deviceId, profile) {
            const payload = await this.postCov({ action: 'setOverride', pointId: deviceId, profile });
            if (!payload) return;
            this.cov = payload;
            this.showSnackbar(profile ? \`Override "\${profile}" on \${deviceId}\` : \`Override cleared on \${deviceId}\`,
                              profile ? 'success' : 'info');
        },
        openBulk() {
            this.bulk = { show: true, profile: '', preview: null, overwriteManual: false, busy: false };
        },
        async previewBulk() {
            if (!this.bulk.profile) { this.bulk.preview = null; return; }
            const ids = this.filteredDevices.filter(d => d.source === 'bacnet').map(d => d.id);
            const payload = await this.postCov({ action: 'preview', profile: this.bulk.profile, pointIds: ids });
            if (payload) { this.cov = payload; this.bulk.preview = payload.preview; }
        },
        async applyBulk() {
            this.bulk.busy = true;
            const ids = this.filteredDevices.filter(d => d.source === 'bacnet').map(d => d.id);
            const payload = await this.postCov({
                action: 'applyToPoints', profile: this.bulk.profile, pointIds: ids,
                overwriteManual: this.bulk.overwriteManual
            });
            this.bulk.busy = false;
            if (!payload) return;
            this.cov = payload;
            const a = payload.applied || {};
            this.showSnackbar(\`\${a.appliedCount} device(s) now use "\${this.bulk.profile}"\` +
                              (a.skippedManual ? \` · \${a.skippedManual} manual override(s) kept\` : ''), 'success');
            this.bulk.show = false;
        },
        toggleRateSort() {
            this.rateSort = this.rateSort === 'desc' ? 'asc' : this.rateSort === 'asc' ? null : 'desc';
        }`);

fk.save(flows);
console.log('profils COV —', fk.summary(flows).nodes, 'nœuds');
