'use strict';
/*
 * Patch — taxonomie des étiquettes, zones et groupes (§ 3 de la feuille de route).
 *
 *   1. `GET/POST /bms/tags` — registre typé, zones, groupes hiérarchiques.
 *   2. Device & Tag Manager : filtre trié par NATURE (Zones · Groupes ·
 *      Fonctions · Rôles · Autres), colonne Zone modifiable, création
 *      d'étiquette AVEC son type, création de groupes de zones.
 *
 * La logique vit dans `lib/bms-core/tags.js` ; ces nœuds ne font que l'exposer.
 *
 * Au passage, deux dettes réglées :
 *   - `tag_create` ne faisait rien (dette P2) : créer une étiquette a désormais
 *     un sens, puisqu'elle doit porter un type pour exister ;
 *   - le Device Manager est câblé en sortie, donc il ne reçoit PAS les messages
 *     entrants en direct (cf. les pièges Dashboard 2.0). Sa table se rafraîchit
 *     maintenant elle-même par HTTP, comme le fait déjà la colonne COV.
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

const tags = global.get('tagPolicy');
if (!tags) {
    msg.statusCode = 503;
    msg.payload = { error: 'BMS not initialised' };
    return msg;
}

const bacnetPoints = global.get('bacnetPoints') || {};
const bmsMetadata = global.get('bmsMetadata') || {};
const virtualPoints = global.get('virtualPoints') || {};

/**
 * Tout ce que le Device & Tag Manager affiche. Le widget est câblé en sortie,
 * donc il ne reçoit pas les messages entrants : il lit cet état lui-même.
 */
function state() {
    const devices = [];
    Object.entries(bacnetPoints).forEach(([id, p]) => {
        const meta = bmsMetadata[id] || { tags: [], zone: '' };
        devices.push({
            id: id, name: p.objectName,
            type: p.access === 'read_only' ? 'sensor' : 'actuator',
            units: p.units, access: p.access, min: p.min, max: p.max, value: p.value,
            zone: meta.zone || '', tags: (meta.tags || []).slice(), source: 'bacnet'
        });
    });
    Object.entries(virtualPoints).forEach(([id, p]) => {
        devices.push({
            id: id, name: p.name, type: 'virtual', units: p.units,
            access: p.writable ? 'read_write' : 'read_only',
            min: p.min, max: p.max, value: p.value,
            zone: '', tags: [], source: 'virtual'
        });
    });

    return {
        devices: devices,
        registry: tags.registry(),
        groups: tags.groups(),
        inventory: tags.inventory(),      // trié par nature, avec les comptes
        types: tags.TAG_TYPES,
        predefined: tags.PREDEFINED,
        zones: tags.zones(),
        migration: tags.migrationReport()
    };
}

const method = ((msg.req && msg.req.method) || 'GET').toUpperCase();

if (method === 'GET') {
    const q = (msg.req && msg.req.query) || {};
    if (q.expand) {
        try {
            msg.payload = tags.expandGroup(q.expand);
        } catch (e) {
            msg.statusCode = 404;
            msg.payload = { error: e.message };
        }
        return msg;
    }
    if (q.pointsIn) {
        msg.payload = { selector: q.pointsIn, points: tags.pointsIn(q.pointsIn) };
        return msg;
    }
    msg.payload = state();
    return msg;
}

const body = msg.payload || {};
const action = body.action;

try {
    let result;
    switch (action) {
        case 'createTag':    result = tags.createTag(body.tag, body.type); break;
        case 'deleteTag':    result = tags.deleteTag(body.tag, { force: !!body.force }); break;
        case 'retypeTag':    result = tags.retypeTag(body.tag, body.type); break;
        case 'renameTag':    result = tags.renameTag(body.from, body.to); break;
        case 'assignTag':    result = tags.assignTag(body.pointId, body.tag); break;
        case 'unassignTag':  result = tags.unassignTag(body.pointId, body.tag); break;
        case 'setZone':      result = tags.setZone(body.pointId, body.zone === undefined ? null : body.zone); break;
        case 'createGroup':  result = tags.createGroup(body.name, body.members || []); break;
        case 'setGroupMembers': result = tags.setGroupMembers(body.name, body.members || []); break;
        case 'deleteGroup':  result = tags.deleteGroup(body.name); break;
        default:
            msg.statusCode = 400;
            msg.payload = { error: 'action attendue : createTag | deleteTag | retypeTag | renameTag | ' +
                                   'assignTag | unassignTag | setZone | createGroup | setGroupMembers | deleteGroup' };
            return msg;
    }
    msg.payload = Object.assign(state(), { result: result });
    return msg;
} catch (e) {
    msg.statusCode = 400;
    msg.payload = { error: e.message };
    return msg;
}`;

fk.addNodes(flows, [
    {
        id: 'bms_api_in_tags_get', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'GET /bms/tags', url: '/bms/tags', method: 'get', upload: false, swaggerDoc: '',
        x: 190, y: 1950, wires: [['bms_api_fn_tags']],
    },
    {
        id: 'bms_api_in_tags_post', type: 'http in', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'POST /bms/tags', url: '/bms/tags', method: 'post', upload: false, swaggerDoc: '',
        x: 190, y: 1990, wires: [['bms_api_fn_tags']],
    },
    {
        id: 'bms_api_fn_tags', type: 'function', z: 'tab_bms_v9', g: 'grp_bms_api',
        name: 'API: tags', func: apiFunc, outputs: 1, timeout: 0, noerr: 0,
        initialize: '', finalize: '', libs: [],
        x: 470, y: 1970, wires: [['bms_api_response']],
    },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Device & Tag Manager
// ─────────────────────────────────────────────────────────────────────────────

// 2a. La barre de filtre, réorganisée par nature. Une zone et un groupe
//     filtrent de la même façon — c'est ce qui rend le groupe utile.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `            <div class="d-flex align-center flex-wrap gap-2 mb-2">
                <v-icon icon="mdi-filter" class="mr-2"></v-icon>
                <span class="text-subtitle-2 mr-3">Filter by Tags:</span>
                <v-chip v-for="tag in allTags" :key="tag"
                    :color="selectedTags.includes(tag) ? 'primary' : 'default'"
                    :variant="selectedTags.includes(tag) ? 'flat' : 'outlined'"
                    size="small" class="ma-1" @click="toggleTagFilter(tag)">
                    {{ tag }} <span class="text-caption ml-1">({{ getTagCount(tag) }})</span>
                </v-chip>
                <v-chip v-if="selectedTags.length > 0" color="error" variant="outlined" size="small" class="ma-1" @click="clearFilters">
                    <v-icon icon="mdi-close" size="small" class="mr-1"></v-icon> Clear
                </v-chip>
            </div>`,
    `            <div v-for="nature in filterNatures" :key="nature.key" class="d-flex align-center flex-wrap nature-row">
                <span class="nature-label">{{ nature.label }}</span>
                <v-chip v-for="it in nature.items" :key="nature.key + ':' + it.tag"
                    :color="isSelected(nature.key, it.tag) ? nature.color : 'default'"
                    :variant="isSelected(nature.key, it.tag) ? 'flat' : 'outlined'"
                    size="small" class="ma-1" @click="toggleFilter(nature.key, it.tag)">
                    {{ it.tag }} <span class="text-caption ml-1">({{ it.count }})</span>
                    <v-icon v-if="nature.key === 'group'" icon="mdi-file-tree-outline" size="x-small" class="ml-1"></v-icon>
                </v-chip>
            </div>
            <div class="d-flex align-center flex-wrap mb-2">
                <span class="nature-label"></span>
                <v-chip v-if="anyFilter" color="error" variant="outlined" size="small" class="ma-1" @click="clearFilters">
                    <v-icon icon="mdi-close" size="small" class="mr-1"></v-icon> Clear filters
                </v-chip>
                <span v-if="selectedZones.length" class="text-caption ml-2">
                    zones: any of {{ zoneFilterSet.join(', ') }}
                </span>
                <span v-if="selectedTags.length" class="text-caption ml-2">
                    · tags: all of {{ selectedTags.join(' + ') }}
                </span>
            </div>`);

// 2b. Création d'étiquette AVEC son type — sans type, une étiquette n'existe pas
//     dans le registre, et c'est ce qui rendait `tag_create` sans effet.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `            <div class="d-flex align-center gap-2">
                <v-text-field v-model="newTagName" label="New tag name" density="compact" variant="outlined" hide-details style="max-width: 200px;" @keyup.enter="createTag"></v-text-field>
                <v-btn color="success" size="small" variant="flat" :disabled="!newTagName.trim()" @click="createTag">
                    <v-icon icon="mdi-plus" class="mr-1"></v-icon> Create Tag
                </v-btn>
                <v-spacer></v-spacer>`,
    `            <div class="d-flex align-center gap-2 flex-wrap">
                <input v-model="newTagName" placeholder="new tag name" class="tag-input"
                       @keyup.enter="newTagName.trim() && createTag()" />
                <select v-model="newTagType" class="tag-input tag-select">
                    <option value="function">function</option>
                    <option value="role">role</option>
                    <option value="zone">zone</option>
                    <option value="other">other</option>
                </select>
                <v-btn color="success" size="small" variant="flat" :disabled="!newTagName.trim()" @click="createTag">
                    <v-icon icon="mdi-plus" class="mr-1"></v-icon> Create tag
                </v-btn>
                <v-btn color="primary" size="small" variant="outlined" @click="openGroup()">
                    <v-icon icon="mdi-file-tree-outline" class="mr-1"></v-icon> Zone group
                </v-btn>
                <v-spacer></v-spacer>`);

// 2c. La zone devient modifiable, dans sa propre colonne.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `                        <td class="text-caption">{{ device.zone }}</td>`,
    `                        <td class="text-caption">
                            <v-menu v-if="device.source === 'bacnet'">
                                <template v-slot:activator="{ props }">
                                    <span v-bind="props" class="zone-chip" :class="{ 'zone-none': !device.zone }">
                                        {{ device.zone || 'no zone' }}
                                    </span>
                                </template>
                                <v-list density="compact" max-height="340">
                                    <v-list-subheader>Zone — exactly one per point</v-list-subheader>
                                    <v-list-item v-for="z in zones" :key="z" :active="device.zone === z"
                                                 @click="setZone(device.id, z)">
                                        <v-list-item-title>{{ z }}</v-list-item-title>
                                    </v-list-item>
                                    <v-divider></v-divider>
                                    <v-list-item :disabled="!device.zone" @click="setZone(device.id, null)">
                                        <v-list-item-title class="text-error">Remove from its zone</v-list-item-title>
                                        <v-list-item-subtitle>the physics engine stops grouping it</v-list-item-subtitle>
                                    </v-list-item>
                                </v-list>
                            </v-menu>
                            <span v-else>—</span>
                        </td>`);

// 2d. Le menu « + » d'affectation, trié par nature lui aussi.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `                                    <v-list density="compact" max-height="300">
                                        <v-list-subheader>Add Tag</v-list-subheader>
                                        <v-list-item v-for="tag in getAvailableTagsFor(device)" :key="tag" @click="addTag(device.id, tag)">
                                            <v-list-item-title>{{ tag }}</v-list-item-title>
                                        </v-list-item>
                                        <v-list-item v-if="getAvailableTagsFor(device).length === 0" disabled>
                                            <v-list-item-title class="text-grey">All tags assigned</v-list-item-title>
                                        </v-list-item>
                                    </v-list>`,
    `                                    <v-list density="compact" max-height="360">
                                        <template v-for="nature in assignableFor(device)" :key="'a' + nature.key">
                                            <v-list-subheader>{{ nature.label }}</v-list-subheader>
                                            <v-list-item v-for="tag in nature.tags" :key="nature.key + tag"
                                                         @click="addTag(device.id, tag)">
                                                <v-list-item-title>{{ tag }}</v-list-item-title>
                                            </v-list-item>
                                        </template>
                                        <v-list-item v-if="assignableFor(device).length === 0" disabled>
                                            <v-list-item-title class="text-grey">All tags assigned</v-list-item-title>
                                        </v-list-item>
                                    </v-list>`);

// 2e. Les étiquettes de la ligne : la zone n'est plus répétée là, elle a sa
//     colonne. Le type se lit à la couleur.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `                                <v-chip v-for="tag in device.tags" :key="tag" size="x-small" variant="outlined" closable @click:close="removeTag(device.id, tag)">{{ tag }}</v-chip>`,
    `                                <v-chip v-for="tag in nonZoneTags(device)" :key="tag" size="x-small"
                                        variant="outlined" :color="tagColor(tag)" closable
                                        @click:close="removeTag(device.id, tag)">{{ tag }}</v-chip>`);

// 2f. Le dialogue de groupe de zones : membres = zones ET autres groupes.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `    <v-snackbar v-model="snackbar.show"`,
    `    <v-dialog v-model="groupDlg.show" max-width="620">
        <v-card>
            <v-card-title class="text-subtitle-1">
                {{ groupDlg.editing ? 'Zone group: ' + groupDlg.name : 'New zone group' }}
            </v-card-title>
            <v-card-text>
                <input v-if="!groupDlg.editing" v-model="groupDlg.name" placeholder="Floor 1, South facade, Building…"
                       class="tag-input" style="width: 100%; margin-bottom: 12px;" />
                <p class="text-caption mb-2">
                    A group holds zones <em>and other groups</em>, so “Building” can hold the floors and
                    a facade can cross them. A group filters exactly like a zone. Cycles are refused.
                </p>
                <div class="group-picker">
                    <div class="group-col">
                        <div class="group-col-head">Zones</div>
                        <label v-for="z in zones" :key="'gz' + z" class="group-opt">
                            <input type="checkbox" :value="z" v-model="groupDlg.members" /> {{ z }}
                        </label>
                    </div>
                    <div class="group-col">
                        <div class="group-col-head">Groups</div>
                        <label v-for="g in groupNames" :key="'gg' + g" class="group-opt"
                               v-show="g !== groupDlg.name">
                            <input type="checkbox" :value="g" v-model="groupDlg.members" /> {{ g }}
                        </label>
                        <div v-if="!groupNames.length" class="text-caption text-grey">none yet</div>
                    </div>
                </div>
                <div v-if="groupDlg.error" class="text-error text-caption mt-2">{{ groupDlg.error }}</div>
            </v-card-text>
            <v-card-actions>
                <v-btn v-if="groupDlg.editing" color="error" variant="text" @click="deleteGroup(groupDlg.name)">Delete</v-btn>
                <v-spacer></v-spacer>
                <v-btn variant="text" @click="groupDlg.show = false">Cancel</v-btn>
                <v-btn color="primary" variant="flat" :disabled="!groupDlg.name.trim()" @click="saveGroup">Save</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show"`);

// 2g. Styles.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `.bulk-warn { color: #e65100; }`,
    `.bulk-warn { color: #e65100; }
.nature-row { margin-bottom: 2px; }
.nature-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6;
                min-width: 78px; display: inline-block; }
.zone-chip { font-size: 12px; padding: 2px 6px; border-radius: 4px; cursor: pointer;
             border: 1px solid rgba(0,0,0,0.12); white-space: nowrap; }
.zone-chip:hover { border-color: #1976d2; }
.zone-none { color: #c62828; font-style: italic; }
.tag-input { padding: 5px 8px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px;
             background: transparent; }
.tag-select { min-width: 108px; }
.group-picker { display: flex; gap: 24px; }
.group-col { flex: 1 1 0; min-width: 0; }
.group-col-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6;
                  margin-bottom: 4px; }
.group-opt { display: block; font-size: 13px; padding: 1px 0; cursor: pointer; }`);

// 2h. État du composant.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        return { devices: [], allTags: [], selectedTags: [], searchQuery: '', newTagName: '',`,
    `        return { devices: [], allTags: [], selectedTags: [], selectedZones: [],
                 inventory: { zone: [], group: [], function: [], role: [], other: [] },
                 registry: {}, groups: {}, zones: [], newTagType: 'function',
                 groupDlg: { show: false, editing: false, name: '', members: [], error: '' },
                 tagsTimer: null,
                 searchQuery: '', newTagName: '',`);

// 2i. Filtre à deux dimensions : les zones et groupes en OU, les autres
//     étiquettes en ET. C'est ce qui permet « étage 1 ou 2, et capteur de CO2 ».
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        filteredDevices() {
            let result = this.devices;
            if (this.selectedTags.length > 0) result = result.filter(d => this.selectedTags.every(tag => d.tags && d.tags.includes(tag)));`,
    `        filteredDevices() {
            let result = this.devices;
            if (this.selectedZones.length > 0) {
                const wanted = new Set(this.zoneFilterSet);
                result = result.filter(d => wanted.has(d.zone));
            }
            if (this.selectedTags.length > 0) result = result.filter(d => this.selectedTags.every(tag => d.tags && d.tags.includes(tag)));`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `        covOverrides() { return this.cov.overrides || {}; },`,
    `        covOverrides() { return this.cov.overrides || {}; },
        groupNames() { return Object.keys(this.groups).sort(); },
        anyFilter() { return this.selectedTags.length > 0 || this.selectedZones.length > 0 || !!this.searchQuery; },
        /** Zones visées par la sélection, groupes développés en zones. */
        zoneFilterSet() {
            const out = new Set();
            for (const sel of this.selectedZones) {
                const g = this.groups[sel];
                if (!g) { out.add(sel); continue; }
                for (const z of this.expandGroup(sel)) out.add(z);
            }
            return [...out].sort();
        },
        filterNatures() {
            const defs = [
                { key: 'zone', label: 'Zones', color: 'indigo' },
                { key: 'group', label: 'Groups', color: 'deep-purple' },
                { key: 'function', label: 'Functions', color: 'teal' },
                { key: 'role', label: 'Roles', color: 'blue-grey' },
                { key: 'other', label: 'Others', color: 'brown' }
            ];
            return defs
                .map(d => ({ ...d, items: this.inventory[d.key] || [] }))
                .filter(d => d.items.length > 0);
        },`);

// 2j. Méthodes : lecture autonome, affectations, zones, groupes.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `    mounted() {
        this.fetchCov();
        this.covTimer = setInterval(this.fetchCov, 5000);
    },
    unmounted() { if (this.covTimer) clearInterval(this.covTimer); },`,
    `    mounted() {
        this.fetchCov();
        this.fetchTags();
        this.covTimer = setInterval(this.fetchCov, 5000);
        // Le widget est câblé en sortie : il ne reçoit pas les messages entrants
        // en direct. Il lit donc son propre état, valeurs comprises.
        this.tagsTimer = setInterval(this.fetchTags, 5000);
    },
    unmounted() {
        if (this.covTimer) clearInterval(this.covTimer);
        if (this.tagsTimer) clearInterval(this.tagsTimer);
    },`);

fk.replaceInTemplate(flows, 'device_manager_ui',
    `        toggleTagFilter(tag) { const idx = this.selectedTags.indexOf(tag); if (idx >= 0) this.selectedTags.splice(idx, 1); else this.selectedTags.push(tag); },
        clearFilters() { this.selectedTags = []; this.searchQuery = ''; },
        getTagCount(tag) { return this.devices.filter(d => d.tags && d.tags.includes(tag)).length; },`,
    `        toggleTagFilter(tag) { const idx = this.selectedTags.indexOf(tag); if (idx >= 0) this.selectedTags.splice(idx, 1); else this.selectedTags.push(tag); },
        toggleFilter(nature, tag) {
            const list = (nature === 'zone' || nature === 'group') ? this.selectedZones : this.selectedTags;
            const idx = list.indexOf(tag);
            if (idx >= 0) list.splice(idx, 1); else list.push(tag);
        },
        isSelected(nature, tag) {
            return (nature === 'zone' || nature === 'group')
                ? this.selectedZones.includes(tag) : this.selectedTags.includes(tag);
        },
        clearFilters() { this.selectedTags = []; this.selectedZones = []; this.searchQuery = ''; },
        getTagCount(tag) { return this.devices.filter(d => d.tags && d.tags.includes(tag)).length; },
        expandGroup(name) {
            const seen = new Set(), zones = new Set();
            const walk = (g) => {
                if (seen.has(g)) return;
                seen.add(g);
                const def = this.groups[g];
                if (!def) return;
                for (const m of def.members || []) {
                    if (this.groups[m]) walk(m); else zones.add(m);
                }
            };
            walk(name);
            return [...zones];
        },
        tagType(tag) { const r = this.registry[tag]; return r ? r.type : 'other'; },
        tagColor(tag) {
            return { zone: 'indigo', function: 'teal', role: 'blue-grey', other: 'brown' }[this.tagType(tag)];
        },
        /** La zone a sa colonne : ne pas la répéter dans les étiquettes. */
        nonZoneTags(device) { return (device.tags || []).filter(t => this.tagType(t) !== 'zone'); },
        assignableFor(device) {
            const defs = [
                { key: 'function', label: 'Functions' },
                { key: 'role', label: 'Roles' },
                { key: 'other', label: 'Others' }
            ];
            return defs
                .map(d => ({ ...d, tags: (this.inventory[d.key] || [])
                    .map(x => x.tag).filter(t => !(device.tags || []).includes(t)) }))
                .filter(d => d.tags.length > 0);
        },
        async fetchTags() {
            try {
                const r = await fetch('/bms/tags');
                if (!r.ok) return;
                this.applyTagState(await r.json());
            } catch (e) { /* dashboard reload */ }
        },
        applyTagState(s) {
            if (s.devices) this.devices = s.devices;
            this.registry = s.registry || {};
            this.groups = s.groups || {};
            this.inventory = s.inventory || this.inventory;
            this.zones = s.zones || [];
            this.allTags = Object.keys(this.registry).sort();
        },
        async postTags(body, okMsg) {
            try {
                const r = await fetch('/bms/tags', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const payload = await r.json();
                if (!r.ok) { this.showSnackbar(payload.error || 'Failed', 'error'); return null; }
                this.applyTagState(payload);
                if (okMsg) this.showSnackbar(okMsg(payload.result), 'success');
                return payload;
            } catch (e) {
                this.showSnackbar('Request failed: ' + e.message, 'error');
                return null;
            }
        },
        async setZone(deviceId, zone) {
            await this.postTags({ action: 'setZone', pointId: deviceId, zone },
                r => zone ? \`\${deviceId} → \${zone}\` + (r.replaced ? ' (was ' + r.replaced.join(', ') + ')' : '')
                          : \`\${deviceId} has no zone any more\`);
        },
        openGroup(name) {
            if (name) {
                this.groupDlg = { show: true, editing: true, name,
                                  members: ((this.groups[name] || {}).members || []).slice(), error: '' };
            } else {
                this.groupDlg = { show: true, editing: false, name: '', members: [], error: '' };
            }
        },
        async saveGroup() {
            const action = this.groupDlg.editing ? 'setGroupMembers' : 'createGroup';
            const payload = await this.postTags({ action, name: this.groupDlg.name.trim(),
                                                  members: this.groupDlg.members });
            if (!payload) return;
            const warn = (payload.result.warnings || []).join(' · ');
            this.showSnackbar(\`Group "\${payload.result.group}" covers \${payload.result.zones.length} zone(s)\` +
                              (warn ? ' · ' + warn : ''), 'success');
            this.groupDlg.show = false;
        },
        async deleteGroup(name) {
            const payload = await this.postTags({ action: 'deleteGroup', name });
            if (!payload) return;
            this.selectedZones = this.selectedZones.filter(z => z !== name);
            this.showSnackbar(\`Group "\${name}" deleted\`, 'warning');
            this.groupDlg.show = false;
        },`);

// 2k. Les trois opérations d'étiquette passent par l'API : un type est requis
//     pour créer, la zone est exclusive pour affecter, et le registre est la
//     seule source de vérité.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        addTag(deviceId, tag) {
            this.send({ topic: 'tag_add', payload: { deviceId, tag } });
            const device = this.devices.find(d => d.id === deviceId);
            if (device) { if (!device.tags) device.tags = []; if (!device.tags.includes(tag)) { device.tags.push(tag); device.tags.sort(); } }
            this.showSnackbar(\`Added "\${tag}" to \${deviceId}\`, 'success');
        },
        removeTag(deviceId, tag) {
            this.send({ topic: 'tag_remove', payload: { deviceId, tag } });
            const device = this.devices.find(d => d.id === deviceId);
            if (device && device.tags) { const idx = device.tags.indexOf(tag); if (idx >= 0) device.tags.splice(idx, 1); }
            const tagStillUsed = this.devices.some(d => d.tags && d.tags.includes(tag));
            if (!tagStillUsed) { const tagIdx = this.allTags.indexOf(tag); if (tagIdx >= 0) this.allTags.splice(tagIdx, 1); this.showSnackbar(\`Removed "\${tag}" (tag deleted)\`, 'warning'); }
            else this.showSnackbar(\`Removed "\${tag}" from \${deviceId}\`, 'info');
        },
        createTag() {
            const tag = this.newTagName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (!tag) return;
            if (this.allTags.includes(tag)) { this.showSnackbar(\`Tag "\${tag}" already exists\`, 'warning'); return; }
            this.allTags.push(tag); this.allTags.sort(); this.newTagName = '';
            this.send({ topic: 'tag_create', payload: { tag } });
            this.showSnackbar(\`Created tag "\${tag}"\`, 'success');
        },`,
    `        async addTag(deviceId, tag) {
            await this.postTags({ action: 'assignTag', pointId: deviceId, tag },
                r => \`"\${tag}" (\${r.type}) on \${deviceId}\` +
                     (r.replaced ? ' — replaced ' + r.replaced.join(', ') : ''));
        },
        async removeTag(deviceId, tag) {
            await this.postTags({ action: 'unassignTag', pointId: deviceId, tag },
                () => \`Removed "\${tag}" from \${deviceId}\`);
        },
        // Une étiquette n'existe que typée : c'est ce qui rendait tag_create
        // sans effet, puisqu'il n'y avait aucun registre où l'inscrire.
        async createTag() {
            const payload = await this.postTags(
                { action: 'createTag', tag: this.newTagName.trim(), type: this.newTagType },
                r => \`Created "\${r.tag}" as \${r.type}\`);
            if (payload) this.newTagName = '';
        },`);

fk.save(flows);
console.log('taxonomie des étiquettes —', fk.summary(flows).nodes, 'nœuds');

// ─────────────────────────────────────────────────────────────────────────────
// 3. Nettoyage de ce que le patch rend inutile
// ─────────────────────────────────────────────────────────────────────────────

// Deux méthodes remplacées par leurs équivalents triés par nature.
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        getAvailableTagsFor(device) { return this.allTags.filter(t => !device.tags || !device.tags.includes(t)); },\n`,
    '');
fk.replaceInTemplate(flows, 'device_manager_ui',
    `        toggleTagFilter(tag) { const idx = this.selectedTags.indexOf(tag); if (idx >= 0) this.selectedTags.splice(idx, 1); else this.selectedTags.push(tag); },\n`,
    '');

/*
 * Le gestionnaire d'étiquettes par topics n'a plus d'émetteur : les trois
 * opérations passent par `/bms/tags`, qui seul sait manipuler le registre typé.
 *
 * Retirer le fil de sortie a un second effet, utile : un ui-template câblé en
 * sortie ne reçoit PAS les messages entrants en direct. Sans ce fil, le widget
 * redevient récepteur, et le rafraîchissement de « Build Device Data » lui
 * parvient à nouveau — en plus de sa propre lecture HTTP.
 */
fk.byId(flows, 'device_manager_ui').wires = [[]];
fk.removeNodes(flows, ['device_tag_handler']);

fk.save(flows);
console.log('nettoyage — gestionnaire par topics retiré,', fk.summary(flows).nodes, 'nœuds');
