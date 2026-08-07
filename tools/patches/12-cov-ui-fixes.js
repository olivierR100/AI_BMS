'use strict';
/*
 * Patch — deux défauts d'affichage de la section « CoV Profiles ».
 *
 * 1. Le champ « Profile name » était un `v-text-field` Vuetify posé au milieu
 *    d'une rangée flex d'`<input>` nus. Vuetify construit ce composant en grille,
 *    avec son étiquette flottante et ses propres enveloppes : dans un
 *    `display: flex; align-items: center` sans largeur minimale, il s'effondre —
 *    l'étiquette se retrouve au milieu des unités et le texte saisi part à la
 *    fin de la rangée, après la case à cocher.
 *
 *    Correction : un `<input type="text">` nu, comme tous les autres champs du
 *    panneau, et sur SA PROPRE ligne. Le formulaire se lit alors dans l'ordre
 *    où on le remplit : nom → incréments → limites → bouton.
 *
 * 2. La boîte du panneau était figée à 22 rangées de grille alors que son
 *    contenu est variable (zéro à N profils, zéro à N affectations). Tous les
 *    autres panneaux de cette page utilisent `height: "0"` — la hauteur
 *    automatique de Dashboard 2.0 — et la boîte s'arrête alors juste après le
 *    dernier élément.
 *
 *    Au passage : les paragraphes explicatifs s'étiraient sur toute la largeur
 *    des 10 colonnes. Une largeur de lecture bornée les rend lisibles sans
 *    toucher à la grille de la page.
 */

const fk = require('../flowkit');
const flows = fk.load();

// ─── 1. Le nom du profil, sur sa propre ligne, en champ nu ──────────────────

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `        <div v-if="settable" class="cv-new">
            <v-text-field v-model="draft.name" label="Profile name" density="compact" variant="outlined"
                          hide-details class="cv-field" placeholder="CO2 fine" />
            <div v-for="u in numericUnits" :key="'d' + u" class="cv-unit">`,
    `        <div v-if="settable" class="cv-row">
            <label for="cv-new-name">New profile</label>
            <input id="cv-new-name" type="text" class="cv-text" v-model="draft.name"
                   placeholder="CO2 fine" @keyup.enter="draft.name.trim() && createProfile()" />
        </div>
        <div v-if="settable" class="cv-new">
            <span class="cv-new-lead">Increments</span>
            <div v-for="u in numericUnits" :key="'d' + u" class="cv-unit">`);

// ─── 2. Styles : champ texte, amorce de rangée, largeur de lecture ──────────

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `    .cv-field { max-width: 200px; }`,
    `    .cv-text { width: 210px; padding: 5px 7px; font-size: 0.85rem; border-radius: 4px;
                border: 1px solid rgba(var(--v-theme-on-surface), 0.25);
                background: transparent; color: rgb(var(--v-theme-on-surface)); }
    .cv-new-lead { font-size: 0.8rem; opacity: 0.75; min-width: 74px; }`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `    .cv-intro { margin: 0 0 4px; font-size: 0.85rem; line-height: 1.5; opacity: 0.85; }`,
    `    .cv-intro { margin: 0 0 4px; font-size: 0.85rem; line-height: 1.5; opacity: 0.85;
                 max-width: 78ch; }`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `    .cv-hint { font-size: 0.8rem; opacity: 0.72; margin-top: 8px; line-height: 1.5; }`,
    `    .cv-hint { font-size: 0.8rem; opacity: 0.72; margin-top: 8px; line-height: 1.5;
                max-width: 78ch; }`);

fk.replaceInTemplate(flows, 'cov_profiles_ui',
    `    .cv-unsupported { margin: 14px 0 4px; padding: 12px 14px; border-radius: 8px;`,
    `    .cv-unsupported { margin: 14px 0 4px; padding: 12px 14px; border-radius: 8px; max-width: 78ch;`);

// ─── 3. Hauteur automatique, comme tous les autres panneaux de la page ──────

const widget = fk.byId(flows, 'cov_profiles_ui');
if (widget.height !== '22') {
    throw new Error(`hauteur attendue « 22 », trouvée « ${widget.height} » — patch déjà appliqué ?`);
}
widget.height = '0';

fk.save(flows);
console.log('correctifs d’affichage COV — hauteur automatique, nom sur sa ligne');
