'use strict';
/*
 * Patch — page « BACnet Server ».
 *
 * L'ancienne page « Hardware Simulator » devient la page du serveur BACnet :
 * on y choisit la source des points — serveur simulé, automate réel, ou
 * simulation interne sans réseau — et on parcourt les objets exposés.
 *
 * Le panneau « Sensor Simulation » existant reste dessous : il ne concerne que
 * la simulation interne, et le nouveau panneau explique quand il s'applique.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─── 1. Renommage de la page ────────────────────────────────────────────────

const page = fk.byId(flows, 'page_simulator');
page.name = 'BACnet Server';
page.path = '/bacnet-server';
page.icon = 'mdi-lan-connect';

// ─── 2. Panneau de connexion ────────────────────────────────────────────────

const widget = `<template>
    <div class="bn">
        <div class="bn-status" :class="statusClass">
            <div class="bn-status-dot"></div>
            <div>
                <div class="bn-status-title">{{ statusTitle }}</div>
                <div class="bn-status-sub">{{ statusDetail }}</div>
            </div>
        </div>

        <div class="bn-section">Point source</div>
        <div class="bn-modes">
            <v-btn v-for="m in modes" :key="m.value" size="small" class="bn-mode"
                   :color="state.mode === m.value ? 'primary' : undefined"
                   :variant="state.mode === m.value ? 'flat' : 'outlined'"
                   :disabled="busy" @click="choose(m.value)">{{ m.label }}</v-btn>
        </div>
        <div class="bn-hint">{{ modeHint }}</div>

        <div v-if="pending === 'real'" class="bn-form">
            <v-text-field v-model="form.host" label="IP address or hostname" density="compact"
                          variant="outlined" hide-details placeholder="192.168.1.50" class="bn-field" />
            <v-text-field v-model="form.port" label="Port" density="compact" variant="outlined"
                          hide-details placeholder="47808" class="bn-field bn-narrow" />
            <v-text-field v-model="form.deviceId" label="Device ID (blank = discover)" density="compact"
                          variant="outlined" hide-details placeholder="1234" class="bn-field bn-narrow" />
        </div>
        <div v-if="pending === 'real'" class="bn-actions">
            <v-btn size="small" color="primary" :loading="busy" :disabled="!form.host"
                   @click="connect('real')">Connect</v-btn>
            <v-btn size="small" variant="text" :disabled="busy" @click="pending = null">Cancel</v-btn>
        </div>

        <div v-if="pending === 'simulated'" class="bn-actions">
            <div class="bn-hint">
                Connects to the bundled test server on
                {{ state.simDefaults.host }}:{{ state.simDefaults.port }} (device
                {{ state.simDefaults.deviceId }}). It must be running —
                <code>bms-sim-start</code>.
            </div>
            <v-btn size="small" color="primary" :loading="busy" @click="connect('simulated')">Connect</v-btn>
            <v-btn size="small" variant="text" :disabled="busy" @click="pending = null">Cancel</v-btn>
        </div>

        <div v-if="feedback" class="bn-feedback" :class="{ bad: feedbackBad }">{{ feedback }}</div>

        <div v-if="state.driver && state.driver.connected" class="bn-metrics">
            <div class="bn-metric"><span>{{ state.driver.bound }}</span> points bound</div>
            <div class="bn-metric"><span>{{ state.driver.covReceived }}</span> COV received</div>
            <div class="bn-metric"><span>{{ state.driver.deviceId }}</span> device id</div>
        </div>

        <div v-if="state.driver && state.driver.connected" class="bn-browse">
            <v-btn size="small" variant="outlined" :loading="browsing" @click="browse">
                {{ objects.length ? 'Refresh object list' : 'Browse objects' }}
            </v-btn>
            <div v-if="objects.length" class="bn-table-wrap">
                <table class="bn-table">
                    <thead><tr><th>Type</th><th>Inst.</th><th>Object name</th><th>Description</th><th>Bound</th></tr></thead>
                    <tbody>
                        <tr v-for="o in objects" :key="o.type + ':' + o.instance">
                            <td>{{ typeName(o.type) }}</td>
                            <td>{{ o.instance }}</td>
                            <td class="bn-mono">{{ o.name }}</td>
                            <td>{{ o.description }}</td>
                            <td>{{ o.boundTo ? '✓' : '—' }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="bn-note">
            <div class="bn-section">About the sensor panel below</div>
            <p v-if="state.mode === 'internal'">
                Internal simulation is active: the sliders below drive the in-memory point
                table directly, and the physics runs inside Node-RED.
            </p>
            <p v-else>
                Points now come from a BACnet server over the network, and its own physics
                owns the sensors. The sliders below only affect the internal simulation, so
                they have no effect in this mode — just as you could not move a real sensor
                by dragging a slider. Switch back to <em>Internal simulation</em> to use them.
            </p>
        </div>
    </div>
</template>

<script>
    export default {
        data() {
            return {
                state: { mode: 'internal', target: null, driver: { connected: false },
                         simDefaults: { host: '127.0.0.1', port: 47810, deviceId: 1234 },
                         pointCount: 0, physicsLocal: true },
                form: { host: '', port: '47808', deviceId: '' },
                pending: null,
                objects: [],
                busy: false, browsing: false,
                feedback: '', feedbackBad: false,
                timer: null
            };
        },
        computed: {
            modes() {
                return [
                    { value: 'internal', label: 'Internal simulation' },
                    { value: 'simulated', label: 'Simulated BACnet server' },
                    { value: 'real', label: 'Real BACnet server' }
                ];
            },
            statusClass() {
                if (this.state.mode === 'internal') return 'is-internal';
                return this.state.driver && this.state.driver.connected ? 'is-live' : 'is-down';
            },
            statusTitle() {
                if (this.state.mode === 'internal') return 'Internal simulation — no network';
                if (!this.state.driver || !this.state.driver.connected) return 'BACnet server not connected';
                return this.state.mode === 'simulated'
                    ? 'Connected to the simulated BACnet server'
                    : 'Connected to a real BACnet server';
            },
            statusDetail() {
                if (this.state.mode === 'internal') {
                    return this.state.pointCount + ' points held in memory, physics running in Node-RED';
                }
                const t = this.state.target;
                const where = t ? (t.host + ':' + t.port) : 'unknown target';
                if (!this.state.driver || !this.state.driver.connected) {
                    return (this.state.driver && this.state.driver.lastError) || where;
                }
                return where + ' · values arrive by COV subscription';
            },
            modeHint() {
                if (this.pending === 'real') return 'Enter the controller address. Leave Device ID blank to discover it.';
                switch (this.state.mode) {
                    case 'internal': return 'Everything stays in memory. No BACnet traffic. This is the default.';
                    case 'simulated': return 'The building simulator runs as a real BACnet/IP device you can browse.';
                    default: return 'Points are read from and written to a real controller.';
                }
            }
        },
        mounted() {
            this.refresh();
            this.timer = setInterval(this.refresh, 4000);
        },
        unmounted() { if (this.timer) clearInterval(this.timer); },
        methods: {
            async refresh() {
                if (this.busy || this.browsing) return;
                try {
                    const r = await fetch('/bms/bacnet');
                    if (r.ok) this.state = await r.json();
                } catch (e) { /* rechargement du dashboard */ }
            },
            choose(mode) {
                this.feedback = '';
                if (mode === 'internal') return this.connect('internal');
                if (mode === this.state.mode && this.state.driver && this.state.driver.connected) return;
                this.pending = mode;
                if (mode === 'real' && this.state.target) {
                    this.form.host = this.state.target.host || '';
                    this.form.port = String(this.state.target.port || 47808);
                    this.form.deviceId = this.state.target.deviceId == null ? '' : String(this.state.target.deviceId);
                }
            },
            async connect(mode) {
                this.busy = true; this.feedback = ''; this.feedbackBad = false;
                const body = { mode };
                if (mode === 'real') {
                    body.host = this.form.host.trim();
                    body.port = Number(this.form.port) || 47808;
                    if (this.form.deviceId !== '') body.deviceId = Number(this.form.deviceId);
                }
                try {
                    const r = await fetch('/bms/bacnet', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const payload = await r.json();
                    if (!r.ok) {
                        this.feedback = payload.error || 'Connection failed.';
                        this.feedbackBad = true;
                    } else {
                        this.state = payload;
                        this.pending = null;
                        this.objects = [];
                        this.feedback = mode === 'internal'
                            ? 'Back to internal simulation.'
                            : 'Connected — ' + (payload.connectResult ? payload.connectResult.bound : 0) + ' points bound.';
                        setTimeout(() => { this.feedback = ''; }, 6000);
                    }
                } catch (e) {
                    this.feedback = 'Request failed: ' + e.message;
                    this.feedbackBad = true;
                } finally { this.busy = false; }
            },
            async browse() {
                this.browsing = true; this.feedback = '';
                try {
                    const r = await fetch('/bms/bacnet?browse=true');
                    const payload = await r.json();
                    if (!r.ok) { this.feedback = payload.error; this.feedbackBad = true; }
                    else { this.objects = payload.objects; }
                } catch (e) {
                    this.feedback = 'Browse failed: ' + e.message; this.feedbackBad = true;
                } finally { this.browsing = false; }
            },
            typeName(t) {
                const names = { 0: 'Analog Input', 1: 'Analog Output', 2: 'Analog Value',
                                3: 'Binary Input', 4: 'Binary Output', 5: 'Binary Value',
                                8: 'Device', 13: 'Multi-state Input', 19: 'Multi-state Value' };
                return names[t] || ('Type ' + t);
            }
        }
    };
</script>

<style>
    .bn { padding: 4px 2px; }
    .bn-status { display: flex; gap: 12px; align-items: center; padding: 12px 14px;
                 border-radius: 8px; margin-bottom: 16px;
                 background: rgba(var(--v-theme-on-surface), 0.05); }
    .bn-status-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
    .is-live .bn-status-dot { background: rgb(var(--v-theme-success)); }
    .is-down .bn-status-dot { background: rgb(var(--v-theme-error)); }
    .is-internal .bn-status-dot { background: rgba(var(--v-theme-on-surface), 0.35); }
    .bn-status-title { font-weight: 600; }
    .bn-status-sub { font-size: 0.82rem; opacity: 0.75; }
    .bn-section { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
                  opacity: 0.65; margin: 16px 0 8px; }
    .bn-modes { display: flex; gap: 8px; flex-wrap: wrap; }
    .bn-mode { text-transform: none; }
    .bn-hint { font-size: 0.82rem; opacity: 0.75; margin-top: 8px; }
    .bn-form { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .bn-field { min-width: 200px; flex: 1 1 200px; }
    .bn-narrow { max-width: 170px; flex: 0 0 170px; }
    .bn-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .bn-feedback { margin-top: 12px; font-size: 0.85rem; }
    .bn-feedback.bad { color: rgb(var(--v-theme-error)); }
    .bn-metrics { display: flex; gap: 24px; margin-top: 16px; flex-wrap: wrap; }
    .bn-metric { font-size: 0.8rem; opacity: 0.75; }
    .bn-metric span { display: block; font-size: 1.4rem; font-weight: 600; opacity: 1;
                      font-variant-numeric: tabular-nums; }
    .bn-browse { margin-top: 18px; }
    .bn-table-wrap { margin-top: 12px; max-height: 320px; overflow: auto; }
    .bn-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .bn-table th { text-align: left; position: sticky; top: 0; padding: 6px 8px;
                   background: rgb(var(--v-theme-surface)); border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.15); }
    .bn-table td { padding: 5px 8px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.07); }
    .bn-mono { font-family: ui-monospace, monospace; }
    .bn-note { margin-top: 22px; font-size: 0.85rem; line-height: 1.5; opacity: 0.85; }
    .bn-note p { margin: 0; }
</style>`;

fk.addNodes(flows, [
    {
        id: 'grp_ui_bacnet', type: 'ui-group', name: 'BACnet Server Connection',
        page: 'page_simulator', width: '10', height: '1', order: 0,
        showTitle: true, className: '', visible: 'true', disabled: 'false',
        groupType: 'default',
    },
    {
        id: 'bacnet_conn_ui', type: 'ui-template', z: 'tab_bms_v9',
        group: 'grp_ui_bacnet', page: '', ui: '', name: 'BACnet Connection UI',
        order: 0, width: '10', height: '18', head: '',
        format: widget,
        // Réception seule : le widget interroge /bms/bacnet lui-même.
        storeOutMessages: false, passthru: false, resendOnRefresh: true,
        templateScope: 'local', className: '',
        x: 900, y: 1860, wires: [[]],
    },
]);

// Le panneau capteurs existant passe en second.
const simGroup = flows.find((n) => n.type === 'ui-group' && n.page === 'page_simulator' && n.id !== 'grp_ui_bacnet');
if (simGroup) {
    simGroup.order = 1;
    simGroup.name = 'Sensor Simulation (internal mode only)';
}

fk.save(flows);
console.log('page « BACnet Server » —', fk.summary(flows).nodes, 'nœuds');
