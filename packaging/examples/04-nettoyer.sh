#!/usr/bin/env bash
#
# Exemple 4 — Supprimer ce que l'exemple 2 a ajouté
#
# Trois façons de retirer des éléments, selon le cas :
#
#   remove_agents / remove_states / remove_widgets : [ids]
#       suppression par identifiant, au niveau racine de la configuration.
#
#   rule_groups: [ { "id": "...", "remove": true } ]
#       suppression d'un groupe de règles entier.
#
#   rule_groups: [ { "id": "...", "remove_rules": ["nom", ...] } ]
#       suppression de règles précises à l'intérieur d'un groupe conservé.
#
# Ces trois formes fonctionnent avec ou sans "merge": true. Sans merge, toute
# section fournie remplace intégralement la section correspondante — c'est
# l'autre méthode de suppression, mais elle exige de renvoyer tout le reste.
#
set -euo pipefail
BMS="${BMS:-http://127.0.0.1:1880/bms}"

echo "═══ Avant ═══"
curl -fsS "${BMS}/context" | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8")).config;
console.log("  agents :", c.behavior_agents.length, "| groupes :", c.rule_groups.length,
            "| états :", c.defined_states.length);
console.log("  démo présente :",
    c.behavior_agents.some((a) => a.id === "agent_demo_reservation") ? "oui" : "non");
'

echo
echo "═══ Suppression ═══"
curl -fsS -X POST "${BMS}/config" -H 'Content-Type: application/json' -d '{
  "merge": true,
  "remove_agents": ["agent_demo_reservation"],
  "remove_states": ["st_demo_salle_fantome"],
  "rule_groups": [ { "id": "rg_demo_reservation", "remove": true } ]
}' | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  opérations :", r.applied.join(", "));
console.log("  compteurs  :", JSON.stringify(r.counts));
'

echo
echo "═══ Après ═══"
curl -fsS "${BMS}/context" | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8")).config;
console.log("  agents :", c.behavior_agents.length, "| groupes :", c.rule_groups.length,
            "| états :", c.defined_states.length);
const reste = c.behavior_agents.some((a) => a.id === "agent_demo_reservation")
           || c.rule_groups.some((g) => g.id === "rg_demo_reservation");
console.log(reste ? "  ✗ des éléments de démonstration subsistent"
                  : "  ✓ configuration de démonstration d’origine restaurée");
'
