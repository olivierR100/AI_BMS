#!/usr/bin/env bash
#
# Exemple 2 — Appliquer une configuration, puis VÉRIFIER qu'elle vit
#
# La leçon principale du projet : « appliqué sans erreur » ne veut pas dire
# « ça marche ». Une règle qui référence un fait inexistant est acceptée sans
# broncher, puis ne se déclenche jamais. Deux garde-fous, toujours :
#
#   1. unknownFacts dans la réponse de POST /config  → doit être vide
#   2. la règle apparaît dans GET /firelog           → puis y déclenche
#
set -euo pipefail
BMS="${BMS:-http://127.0.0.1:1880/bms}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "═══ 1. Application de 02-regle-etat.json ═══"
RESPONSE=$(curl -fsS -X POST "${BMS}/config" \
    -H 'Content-Type: application/json' \
    --data-binary "@${HERE}/02-regle-etat.json")

echo "${RESPONSE}" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  appliqué :", r.applied);
console.log("  compteurs:", JSON.stringify(r.counts));

const unknown = r.unknownFacts || [];
const errors  = r.errors || [];

if (unknown.length) {
    console.log("\n  ⚠ FAITS INCONNUS :", unknown.join(", "));
    console.log("    Les règles qui les utilisent ne se déclencheront JAMAIS.");
    console.log("    Corrigez les identifiants (GET /bms/context les liste tous).");
    process.exit(1);
}
console.log("  ✓ aucun fait inconnu");

if (errors.length) {
    console.log("  ⚠ erreurs :", JSON.stringify(errors));
    process.exit(1);
}
'

echo
echo "═══ 2. La règle est-elle chargée ? ═══"
curl -fsS "${BMS}/firelog" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const group = (d.groups || []).find((g) => g.id === "rg_demo_reservation");
if (!group) {
    console.log("  ✗ groupe rg_demo_reservation absent du firelog");
    console.log("    groupes présents :", (d.groups || []).map((g) => g.id).join(", "));
    process.exit(1);
}
console.log(`  ✓ groupe chargé : ${group.name} (${group.enabled ? "actif" : "désactivé"})`);
for (const name of group.rules || []) console.log(`      · ${name}`);
console.log("  total de règles dans le moteur :", d.rulesLoaded);
'

echo
echo "═══ 3. Provoquer le déclenchement ═══"
echo "  On réserve la salle, sans personne dedans :"
curl -fsS -X POST "${BMS}/points" -H 'Content-Type: application/json' \
    -d '{"id":"f1_meet_booking","value":true}' >/dev/null
curl -fsS -X POST "${BMS}/points" -H 'Content-Type: application/json' \
    -d '{"id":"f1_meet_motion","value":false,"simulate":true}' >/dev/null
echo "    f1_meet_booking = true"
echo "    f1_meet_motion  = false (forcé)"

echo "  Attente du prochain cycle du moteur (3 s)…"
sleep 3

curl -fsS "${BMS}/points?id=st_demo_salle_fantome" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const v = typeof d === "object" && "value" in d ? d.value : d;
console.log("  st_demo_salle_fantome =", JSON.stringify(v));
console.log(v === true
    ? "  ✓ la règle a bien basculé l’état"
    : "  ✗ état non levé — voir GET /bms/firelog et GET /bms/syslog?level=warn");
'

echo "  Trace de déclenchement dans le firelog :"
curl -fsS "${BMS}/firelog" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const hits = Object.entries(d.fireLog || {}).filter(([n]) => /réservations|signaler|libérée/i.test(n));
if (!hits.length) { console.log("    (aucune — la règle est chargée mais ne déclenche pas)"); process.exit(0); }
for (const [name, info] of hits) {
    console.log(`    ${new Date(info.lastFired).toLocaleTimeString("fr-FR")}  ${name}`);
}
'

echo
echo "═══ 4. Remettre les choses en place ═══"
curl -fsS -X POST "${BMS}/points" -H 'Content-Type: application/json' \
    -d '{"id":"f1_meet_booking","value":false}' >/dev/null
echo "  réservation annulée (l'état retombera au prochain cycle)"
echo
echo "  Pour retirer complètement cet exemple :  ./04-nettoyer.sh"
