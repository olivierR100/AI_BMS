# AI BMS — démonstrateur

Gestion technique de bâtiment pilotée par IA, sur Node-RED.

Un bâtiment de trois étages entièrement simulé — 86 points, 13 zones — que l'on
automatise en langage naturel : on décrit une intention à un assistant, il écrit
les règles, le bâtiment les applique. Aucun matériel n'est nécessaire.

---

## Démarrage

Sous Windows, dans un terminal **Ubuntu (WSL)** :

```bash
tar xzf ai-bms-poc-*.tar.gz
cd ai-bms-poc-*/
./install.sh
```

Une quinzaine de minutes plus tard, le dashboard répond sur
<http://127.0.0.1:1880/dashboard/>.

Si WSL n'est pas encore installé sur le poste, commencez par la section 2 de
`INSTALLATION.md`.

---

## Ensuite

| Document | À lire quand |
|---|---|
| **INSTALLATION.md** | Installation détaillée, options, diagnostic, désinstallation |
| **UTILISATION.md** | Prise en main : les pages, les concepts, l'assistant, l'API |
| `examples/` | Quatre scripts commentés, à lancer dans l'ordre |
| `docs/` | Schéma de configuration, architecture, audit technique |

Le plus rapide pour comprendre ce que fait le système : lancer
`examples/03-scenario.sh` avec le Control Panel ouvert à côté.

---

## Contenu de l'archive

```
install.sh              installateur WSL, ré-exécutable
flows.json              les flows Node-RED — le système lui-même
settings.js             configuration du runtime (secrets à générer)
package.json            les 5 modules de palette requis
seed/global.json        configuration de démonstration : 7 agents, 130 règles
examples/               scripts d'exemple commentés
docs/                   documentation de référence
claude-code/            intégration Claude Code (facultative)
```

Node.js, Node-RED et les modules de palette ne sont pas dans l'archive :
`install.sh` les télécharge depuis NodeSource et npm.

---

## Sécurité

L'archive **ne contient aucun secret**. L'installateur génère à chaque
installation le mot de passe de l'éditeur, le jeton d'API Admin et la clé de
chiffrement des identifiants, et les récapitule dans `~/.node-red/ACCES.txt`.

Les clés d'API des fournisseurs LLM sont à saisir dans l'interface, et y restent
visibles à dessein : elles sont stockées en clair dans le contexte Node-RED,
pensez à les effacer avant de transmettre la machine ou une sauvegarde.

En l'état, le PoC est prévu pour tourner sur `127.0.0.1`. Avant toute exposition
réseau, lisez `INSTALLATION.md` § 5.3.
