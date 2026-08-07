#!/usr/bin/env bash
#
# Exemple 1 — Découvrir le bâtiment
#
# Ce que le PoC sait de lui-même : points matériels, points virtuels,
# étiquettes, et configuration actuellement appliquée.
#
set -euo pipefail
BMS="${BMS:-http://127.0.0.1:1880/bms}"

echo "═══ Combien de points, et de quel type ? ═══"
curl -fsS "${BMS}/context" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  capteurs      :", Object.keys(d.points.sensors).length);
console.log("  actionneurs   :", Object.keys(d.points.actuators).length);
console.log("  météo         :", Object.keys(d.points.weather).length);
console.log("  points virtuels:", Object.keys(d.virtualPoints).length);
'

echo
echo "═══ Les capteurs de présence du 1er étage ═══"
curl -fsS "${BMS}/points?tag=motion" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const [id, v] of Object.entries(d)) {
    if (id.startsWith("f1_")) console.log(`  ${id.padEnd(22)} ${v}`);
}
'

echo
echo "═══ Détail d'un point précis ═══"
curl -fsS "${BMS}/points?id=f1_meet_temp" | node -e '
console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2)
    .split("\n").map((l) => "  " + l).join("\n"));
'

echo
echo "═══ Que tourne-t-il actuellement ? ═══"
curl -fsS "${BMS}/firelog" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  règles chargées :", d.rulesLoaded);
console.log("  physique active :", d.physics_enabled);
console.log("  agents          :", (d.agents || []).map((a) => a.name || a.id).join(", "));
const fired = Object.entries(d.fireLog || {});
console.log(`  règles ayant déclenché : ${fired.length}`);
for (const [name, info] of fired.slice(0, 5)) {
    console.log(`    ${new Date(info.lastFired).toLocaleTimeString("fr-FR")}  ${name}`);
}
'
