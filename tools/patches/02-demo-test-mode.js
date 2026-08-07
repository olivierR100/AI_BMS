'use strict';
/*
 * Patch — mode Démo / Test avec multiplicateur de vitesse du temps.
 *
 * Problème : les temporisations réelles du bâtiment (15 min d'inoccupation)
 * rendent une démonstration en direct impossible, et un jeu de règles neuf
 * indémontrable sans attendre.
 *
 * Approche : une horloge système unique, BMS.now(). Tous les faits temporels en
 * dérivent. Le multiplicateur par défaut est 1, auquel BMS.now() renvoie
 * exactement new Date() — aucun changement de comportement tant que personne
 * ne touche au réglage.
 *
 * Le réglage vit dans un onglet dédié, séparé des pages d'exploitation, pour
 * qu'on ne l'active jamais par accident en production.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─────────────────────────────────────────────────────────────────────────────
// 1. BMS.now() — l'horloge du système
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInFunc(flows, 'Initialize System (V12)',
    `    getValue: function(id) {
        const bp = global.get('bacnetPoints') || {};`,
    `    // Horloge du système. Tout fait temporel (heure, minute de la semaine,
    // minuteurs d'occupation, position du soleil) passe par ici, afin que le
    // mode Démo/Test puisse accélérer le temps sans qu'aucune règle ne change.
    // Au multiplicateur 1 — le défaut — c'est strictement l'horloge réelle.
    now: function() {
        const c = global.get('demoClock');
        if (!c || !c.multiplier || c.multiplier === 1) return new Date();
        return new Date(c.anchorVirtual + (Date.now() - c.anchorReal) * c.multiplier);
    },

    getValue: function(id) {
        const bp = global.get('bacnetPoints') || {};`);

// Initialisation de l'horloge : seul le multiplicateur est persisté. Les points
// d'ancrage sont repris à chaque démarrage, sinon un arrêt d'une nuit
// téléporterait l'horloge virtuelle à des semaines de là.
fk.replaceInFunc(flows, 'Initialize System (V12)',
    `// Restore AI configuration from the persistent 'file' context store (survives restarts)`,
    `// Horloge Démo/Test. Seul le multiplicateur survit au redémarrage : les ancres
// sont reprises maintenant, pour que l'horloge virtuelle reparte du temps réel.
let demoMultiplier = 1;
try {
    const persistedMultiplier = global.get('demoClockMultiplier', 'file');
    if (typeof persistedMultiplier === 'number' && persistedMultiplier > 0) demoMultiplier = persistedMultiplier;
} catch (e) { /* file store not configured */ }
global.set('demoClock', { multiplier: demoMultiplier, anchorReal: Date.now(), anchorVirtual: Date.now() });
if (demoMultiplier !== 1) node.warn('⏩ Demo/Test mode actif au démarrage : temps ×' + demoMultiplier);

// Restore AI configuration from the persistent 'file' context store (survives restarts)`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Les producteurs de faits temporels passent par l'horloge
// ─────────────────────────────────────────────────────────────────────────────

fk.replaceInFunc(flows, 'cf352adf5f78d03f',   // Update time (LOGIC KERNEL, 1 s)
    `const BMS = global.get('BMS');
const now = new Date();`,
    `const BMS = global.get('BMS');
const now = (BMS && BMS.now) ? BMS.now() : new Date();   // horloge système (cf. mode Démo/Test)`);

fk.replaceInFunc(flows, 'Calculate Sun',
    `const now = new Date();`,
    `const now = (BMS && BMS.now) ? BMS.now() : new Date();   // horloge système (cf. mode Démo/Test)`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Suppression du second metteur à jour du temps (doublon signalé par l'audit)
//    « Update Time » (VIRTUAL POINTS, 60 s) recalcule un sous-ensemble de ce que
//    « Update time » (LOGIC KERNEL, 1 s) produit déjà, et sa sortie est vide.
//    Le laisser vivre, c'est deux horloges à migrer au lieu d'une.
// ─────────────────────────────────────────────────────────────────────────────

const envGroup = fk.byId(flows, 'grp_env_data');
envGroup.nodes = (envGroup.nodes || []).filter((id) => id !== 'env_time_update');
fk.removeNodes(flows, ['env_time_update']);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Endpoints /bms/demomode
// ─────────────────────────────────────────────────────────────────────────────

const apiHandler = `// Optional auth: if BMS_API_TOKEN env var is set on the Node-RED process,
// require it in the x-bms-token header (endpoints are otherwise open like the dashboard)
const required = env.get('BMS_API_TOKEN');
if (required && (!msg.req || msg.req.headers['x-bms-token'] !== required)) {
    msg.statusCode = 401;
    msg.payload = { error: 'unauthorized' };
    return msg;
}

const BMS = global.get('BMS');
const ALLOWED = [1, 2, 5, 10, 30, 60, 120];

function currentState() {
    const c = global.get('demoClock') || { multiplier: 1 };
    const multiplier = c.multiplier || 1;
    const virtual = (BMS && BMS.now) ? BMS.now() : new Date();

    // Rend concret l'effet du réglage : la temporisation d'inoccupation est la
    // constante qui rend une démonstration en direct impraticable à 1×.
    const states = global.get('stateRegistry') || [];
    const cache = global.get('myStateCache');
    const def = states.find(s => s.id === 'st_timeout_office');
    let timeoutMinutes = null;
    if (def) {
        const live = cache ? cache.get('st_timeout_office') : undefined;
        timeoutMinutes = (live !== undefined) ? live : def.defaultValue;
    }

    return {
        multiplier: multiplier,
        accelerated: multiplier !== 1,
        allowed: ALLOWED,
        virtualTime: virtual.toISOString(),
        realTime: new Date().toISOString(),
        occupancyTimeoutMinutes: timeoutMinutes,
        occupancyTimeoutRealSeconds: (timeoutMinutes === null) ? null : Math.round(timeoutMinutes * 60 / multiplier)
    };
}

const method = ((msg.req && msg.req.method) || 'GET').toUpperCase();
if (method === 'GET') {
    msg.payload = currentState();
    return msg;
}

const requested = Number((msg.payload || {}).multiplier);
if (!ALLOWED.includes(requested)) {
    msg.statusCode = 400;
    msg.payload = { error: 'multiplier must be one of ' + ALLOWED.join(', '), received: (msg.payload || {}).multiplier };
    return msg;
}

// Ré-ancrage : l'heure virtuelle courante devient la nouvelle origine, sinon
// changer de vitesse ferait sauter l'horloge en avant ou en arrière.
const virtualNow = ((BMS && BMS.now) ? BMS.now() : new Date()).getTime();
global.set('demoClock', { multiplier: requested, anchorReal: Date.now(), anchorVirtual: virtualNow });
try { global.set('demoClockMultiplier', requested, 'file'); } catch (e) { /* file store not configured */ }

node.warn('⏩ Demo/Test mode : multiplicateur de temps réglé sur ×' + requested);
msg.payload = currentState();
return msg;`;

fk.addNodes(flows, [
    {
        id: 'bms_api_in_demomode_get', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'GET /bms/demomode', url: '/bms/demomode', method: 'get',
        upload: false, swaggerDoc: '', x: 190, y: 1660, wires: [['bms_api_fn_demomode']],
    },
    {
        id: 'bms_api_in_demomode_post', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'POST /bms/demomode', url: '/bms/demomode', method: 'post',
        upload: false, swaggerDoc: '', x: 190, y: 1700, wires: [['bms_api_fn_demomode']],
    },
    {
        id: 'bms_api_fn_demomode', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'API: demomode', func: apiHandler, outputs: 1, timeout: 0,
        noerr: 0, initialize: '', finalize: '', libs: [],
        x: 470, y: 1680, wires: [['bms_api_response']],
    },
]);

const apiGroup = fk.byId(flows, 'grp_bms_api');
apiGroup.nodes.push('bms_api_in_demomode_get', 'bms_api_in_demomode_post', 'bms_api_fn_demomode');
apiGroup.h = (apiGroup.h || 200) + 90;

// ─────────────────────────────────────────────────────────────────────────────
// 5. Page dashboard « Demo / Test Mode »
// ─────────────────────────────────────────────────────────────────────────────

const widget = `<template>
    <div class="dtm">
        <v-alert v-if="state.accelerated" type="warning" variant="tonal" density="compact" class="dtm-banner">
            <strong>Time is running {{ state.multiplier }}× faster than real time.</strong>
            Schedules, occupancy hold-offs and state expiry all elapse faster than they will
            in production. Return to 1× before judging how the building really behaves.
        </v-alert>

        <div class="dtm-clocks">
            <div class="dtm-clock">
                <div class="dtm-label">System clock — what the rules see</div>
                <div class="dtm-value" :class="{ hot: state.accelerated }">{{ clockText(state.virtualTime) }}</div>
                <div class="dtm-sub">{{ dateText(state.virtualTime) }}</div>
            </div>
            <div class="dtm-clock">
                <div class="dtm-label">Real time</div>
                <div class="dtm-value dim">{{ clockText(state.realTime) }}</div>
                <div class="dtm-sub dim">{{ dateText(state.realTime) }}</div>
            </div>
        </div>

        <div class="dtm-section">Time speed</div>
        <div class="dtm-buttons">
            <v-btn v-for="m in state.allowed" :key="m"
                   :color="m === state.multiplier ? 'primary' : undefined"
                   :variant="m === state.multiplier ? 'flat' : 'outlined'"
                   :disabled="busy" size="small" class="dtm-btn"
                   @click="setMultiplier(m)">{{ m }}×</v-btn>
        </div>

        <div class="dtm-effect" v-if="state.occupancyTimeoutRealSeconds !== null">
            The occupancy hold-off is <strong>{{ state.occupancyTimeoutMinutes }} min</strong> of system time,
            which at {{ state.multiplier }}× is
            <strong>{{ humanSeconds(state.occupancyTimeoutRealSeconds) }}</strong> of real waiting.
        </div>

        <v-btn v-if="state.accelerated" variant="text" size="small" class="dtm-reset"
               :disabled="busy" @click="setMultiplier(1)">Back to real time</v-btn>

        <div class="dtm-note">
            <div class="dtm-section">What this does</div>
            <p>
                Every time-derived fact — hour of day, minute of week, the monotonic counter
                behind every timer, and the sun position — is computed from a single system
                clock. Speeding that clock up lets a 15-minute hold-off or an evening schedule
                be demonstrated in seconds, without editing a single rule.
            </p>
            <p>
                The physics simulation and the rule engine keep running on their own real-time
                ticks, so at high multipliers temperatures and CO<sub>2</sub> lag behind the
                clock. Use up to 10× to watch a building settle; use 60× or more to fast-forward
                to a scheduled event.
            </p>
            <p class="dtm-warn">
                The multiplier survives a restart. If a demo left it at 60×, the banner above
                will say so on the next boot.
            </p>
        </div>

        <div class="dtm-feedback" v-if="feedback">{{ feedback }}</div>
    </div>
</template>

<script>
    export default {
        data() {
            return {
                state: {
                    multiplier: 1, accelerated: false, allowed: [1, 2, 5, 10, 30, 60, 120],
                    virtualTime: new Date().toISOString(), realTime: new Date().toISOString(),
                    occupancyTimeoutMinutes: null, occupancyTimeoutRealSeconds: null
                },
                busy: false,
                feedback: '',
                timer: null
            };
        },
        mounted() {
            this.refresh();
            // Ce widget est en réception seule (aucun fil de sortie) : il va
            // chercher son état lui-même. Un widget câblé en sortie ne reçoit
            // pas les messages entrants dans Dashboard 2.0.
            this.timer = setInterval(this.refresh, 1000);
        },
        unmounted() {
            if (this.timer) clearInterval(this.timer);
        },
        methods: {
            async refresh() {
                if (this.busy) return;
                try {
                    const r = await fetch('/bms/demomode');
                    if (r.ok) this.state = await r.json();
                } catch (e) { /* le dashboard peut être rechargé pendant la requête */ }
            },
            async setMultiplier(m) {
                this.busy = true;
                this.feedback = '';
                try {
                    const r = await fetch('/bms/demomode', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ multiplier: m })
                    });
                    const body = await r.json();
                    if (!r.ok) {
                        this.feedback = body.error || 'Could not change the time speed.';
                    } else {
                        this.state = body;
                        this.feedback = m === 1 ? 'Back to real time.' : 'Time speed set to ' + m + '×.';
                        setTimeout(() => { this.feedback = ''; }, 4000);
                    }
                } catch (e) {
                    this.feedback = 'Request failed: ' + e.message;
                } finally {
                    this.busy = false;
                }
            },
            clockText(iso) {
                if (!iso) return '--:--:--';
                return new Date(iso).toLocaleTimeString('en-GB');
            },
            dateText(iso) {
                if (!iso) return '';
                return new Date(iso).toLocaleDateString('en-GB',
                    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            },
            humanSeconds(s) {
                if (s === null || s === undefined) return '—';
                if (s < 90) return s + ' s';
                const m = Math.round(s / 60);
                if (m < 90) return m + ' min';
                return (Math.round(m / 6) / 10) + ' h';
            }
        }
    };
</script>

<style>
    .dtm { padding: 4px 2px; }
    .dtm-banner { margin-bottom: 16px; }
    .dtm-clocks { display: flex; gap: 32px; flex-wrap: wrap; margin-bottom: 20px; }
    .dtm-clock { min-width: 180px; }
    .dtm-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; }
    .dtm-value { font-size: 2.1rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
    .dtm-value.hot { color: rgb(var(--v-theme-warning)); }
    .dtm-value.dim, .dtm-sub.dim { opacity: 0.55; }
    .dtm-sub { font-size: 0.8rem; opacity: 0.7; }
    .dtm-section { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
                   opacity: 0.65; margin: 18px 0 8px; }
    .dtm-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    .dtm-btn { min-width: 56px; }
    .dtm-effect { margin-top: 14px; font-size: 0.9rem; }
    .dtm-reset { margin-top: 10px; }
    .dtm-note { margin-top: 22px; font-size: 0.85rem; line-height: 1.5; opacity: 0.85; }
    .dtm-note p { margin: 0 0 10px; }
    .dtm-warn { opacity: 0.75; font-style: italic; }
    .dtm-feedback { margin-top: 12px; font-size: 0.85rem; opacity: 0.8; }
</style>`;

fk.addNodes(flows, [
    {
        id: 'page_demo_test', type: 'ui-page', name: 'Demo / Test Mode',
        ui: 'conf_ui_base', path: '/demo-test', icon: 'mdi-flask-outline',
        layout: 'grid', theme: 'conf_theme',
        breakpoints: [
            { name: 'Default', px: 0, cols: 3 },
            { name: 'Tablet', px: 576, cols: 6 },
            { name: 'Small Desktop', px: 768, cols: 9 },
            { name: 'Desktop', px: 1024, cols: 12 },
        ],
        order: 7, className: '', visible: true, disabled: false,
    },
    {
        id: 'grp_ui_demo_mode', type: 'ui-group', name: 'Time & Test Controls',
        page: 'page_demo_test', width: '8', height: '1', order: 1,
        showTitle: true, className: '', visible: 'true', disabled: 'false',
        groupType: 'default',
    },
    {
        id: 'demo_test_ui', type: 'ui-template', z: 'tab_bms_v9',
        group: 'grp_ui_demo_mode', page: '', ui: '', name: 'Demo/Test Mode UI',
        order: 0, width: '8', height: '16', head: '',
        format: widget,
        // Réception seule : pas de fil de sortie, donc pas besoin de
        // storeOutMessages/passthru. Le widget interroge l'API lui-même.
        storeOutMessages: false, passthru: false, resendOnRefresh: true,
        templateScope: 'local', className: '',
        x: 900, y: 1700, wires: [[]],
    },
]);

fk.save(flows);

const s = fk.summary(flows);
console.log(`flows.json : ${s.nodes} nœuds`);
console.log(`  ui-page ${s.types['ui-page']}, http in ${s.types['http in']}, function ${s.types.function}`);
console.log('mode Démo/Test ajouté : BMS.now(), /bms/demomode, page /demo-test');
console.log('doublon retiré : env_time_update');
