#!/usr/bin/env bash
#
# Exemple 3 — Jouer un scénario de bâtiment
#
# On force des capteurs, puis on regarde la configuration de démonstration
# piloter d'elle-même l'éclairage, la ventilation et la consigne de température
# du bureau F2/1.
#
# Deux façons d'écrire une valeur, à ne pas confondre :
#
#   {"id":…, "value":…, "simulate":true}
#       écrit directement le point matériel simulé, comme le ferait un vrai
#       capteur. C'est le seul moyen d'agir sur une entrée (présence, CO2…).
#       L'écriture est ponctuelle : la physique simulée reprend ensuite sa
#       dérive à partir de cette valeur.
#
#   {"id":…, "value":…}
#       écriture normale à travers la couche BMS : droits d'accès vérifiés,
#       bornes min/max appliquées. Pour les sorties (lampes, consignes…).
#
# Les états internes (st_*) ne sont accessibles qu'en lecture : seules les
# règles les modifient, via des événements set_state.
#
set -euo pipefail
BMS="${BMS:-http://127.0.0.1:1880/bms}"

etat() {
    curl -fsS "${BMS}/points" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const show = (ids) => ids
    .map((id) => `${id.replace(/^(f2_off1|st_off_f2_1)_/, "")}=${JSON.stringify(d[id])}`)
    .join("  ");
console.log("    capteurs :", show(["f2_off1_motion", "f2_off1_co2", "f2_off1_temp"]));
console.log("    états    :", show(["st_off_f2_1_occupied", "st_off_f2_1_co2_stage"]));
console.log("    sorties  :", show(["f2_off1_lamp", "f2_off1_vent", "f2_off1_temp_setpoint"]));
'
}

capteur() {  # capteur <id> <valeur>
    curl -fsS -X POST "${BMS}/points" -H 'Content-Type: application/json' \
        -d "{\"id\":\"$1\",\"value\":$2,\"simulate\":true}" >/dev/null
}

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Scénario : une journée de travail — bureau F2/1         ║"
echo "╚══════════════════════════════════════════════════════════╝"

echo
echo "── Bureau vide ────────────────────────────────────────────"
capteur f2_off1_motion false
capteur f2_off1_co2    420
sleep 3
etat

echo
echo "── Quelqu'un arrive ───────────────────────────────────────"
capteur f2_off1_motion true
sleep 4
etat
echo "    → la présence lève st_off_f2_1_occupied, ce qui allume la"
echo "      lampe et met la consigne en confort (glob_comfort_sp)."

echo
echo "── Réunion à quatre, le CO2 grimpe ────────────────────────"
capteur f2_off1_co2 950
sleep 4
etat
echo "    → au-delà de 800 ppm le palier passe à 1 : ventilation 40 %."

echo
echo "── Air vicié, seuil haut ──────────────────────────────────"
capteur f2_off1_co2 1350
sleep 4
etat
echo "    → au-delà de 1200 ppm, palier 2 : ventilation 80 %."

echo
echo "── Tout le monde repart ───────────────────────────────────"
capteur f2_off1_motion false
capteur f2_off1_co2    500
sleep 4
etat
echo
echo "    La lampe reste allumée : l'inoccupation est temporisée."
curl -fsS "${BMS}/points" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const reste = (d.st_off_f2_1_occ_timer || 0) - (d.glob_time_epoch_min || 0);
console.log(`    Temporisation : ${d.st_timeout_office} min (état st_timeout_office).`);
console.log(reste > 0
    ? `    Extinction dans environ ${reste} min, sauf nouvelle détection.`
    : "    Temporisation échue : l’extinction intervient au prochain cycle.");
console.log("    Pour la raccourcir en démonstration, modifiez st_timeout_office");
console.log("    dans l’onglet Logic Inspector du dashboard.");
'

echo
echo "── Qu'est-ce qui a réellement déclenché ? ─────────────────"
curl -fsS "${BMS}/firelog" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const hits = Object.entries(d.fireLog || {})
    .filter(([n]) => /F2 Off1|Office F2\.1/i.test(n))
    .sort((a, b) => b[1].lastFired - a[1].lastFired)
    .slice(0, 10);
if (!hits.length) { console.log("  (aucune règle de cette zone n’a déclenché)"); process.exit(0); }
for (const [name, info] of hits) {
    const p = info.event?.params || {};
    const v = p.value !== undefined ? p.value
            : p.value_from_fact ? `← ${p.value_from_fact}`
            : "";
    console.log(`  ${new Date(info.lastFired).toLocaleTimeString("fr-FR")}  ${name}  ${v}`);
}
'

echo
echo "Les capteurs restent sur leurs dernières valeurs forcées et"
echo "recommencent à dériver avec la physique simulée."
