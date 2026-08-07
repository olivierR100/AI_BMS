# AI BMS — travaux en cours et prochaines étapes

État au 2026-08-07. Ce document est le relais entre sessions : il porte le
détail d'implémentation qu'un résumé de conversation perd.

Voir `CLAUDE.md` pour l'architecture, `audit/2026-06-12_audit.md` pour les
limitations connues, `packaging/` pour la distribution.

---

## Où en est le système

Déployé et vérifié : 55 tests verts (`node --test --test-concurrency=1 test/`),
Node-RED sur 1880, serveur BACnet de test sur 47810 (contrôle 47811).

| Brique | État |
|---|---|
| Cœur extrait dans `lib/bms-core/` | fait |
| Harnais de tests (scénarios + unitaires) | fait, 55 tests |
| Mode Démo/Test (horloge accélérée) | fait, dans Settings |
| Couche pilote, écritures async, qualité/péremption | fait |
| Enveloppe de sécurité (traçabilité, cadence, approbation) | fait |
| Serveur BACnet/IP de test + physique | fait |
| Pilote BACnet/IP client (parcours, COV, écritures) | fait |
| Page « BACnet Server » (modes, connexion, parcours) | fait |
| Canal de contrôle hors-bande du simulateur | fait |
| Analyse statique des règles | fait, calibrée (14 avertissements sur la démo) |

---

## 1. Supprimer le mode « internal » — À FAIRE EN PREMIER

Objectif : une seule source de points, BACnet. Le mode `internal` (table en
mémoire + physique dans Node-RED) fait doublon avec le serveur BACnet simulé et
double le nombre de chemins à maintenir.

**L'ordre compte : le harnais d'abord.** Tant que `internal` existe encore, il
sert de filet pendant qu'on bascule les tests.

### 1.1 Harnais (`test/lib/harness.js`)

`startInstance()` doit démarrer un serveur BACnet par exécution :

- allouer un **second port libre** (`freePort()`) pour BACnet, un **troisième**
  pour le canal de contrôle ;
- `spawn` de `lib/bacnet-sim/server.js` avec un `--device-id` propre à
  l'exécution (éviter les collisions entre exécutions parallèles) ;
- attendre Node-RED, puis
  `POST /bms/bacnet {mode:'real', host:'127.0.0.1', port, deviceId}`.

> **Utiliser `real`, pas `simulated`** : le mode `simulated` code en dur
> 127.0.0.1:47810 / device 1234 (`SIM_DEFAULTS` dans le nœud `API: bacnet`).
> Deux exécutions simultanées entreraient en collision.

- `stop()` doit arrêter les deux processus.

**Attendre des tests plus lents.** Les valeurs transitent désormais par une
notification COV au lieu d'une mutation en mémoire. Prévoir d'élargir certains
`expectPoint` (surtout `Ventilation — paliers CO2`, qui enchaîne quatre
transitions). Ne pas masquer une régression derrière un timeout : si une
attente dépasse ~20 s, chercher la cause.

**Faire passer les 55 tests en mode BACnet avant de supprimer quoi que ce soit.**

### 1.2 Suppressions (une fois le harnais vert)

| Quoi | Où |
|---|---|
| Nœud `Physics Simulator` + son inject `Physics ~2s` | `flows.json` (via `tools/flowkit.js`) |
| Branche `internal` du nœud `Write` | `flows.json` |
| `'internal'` de l'énumération de modes | nœud `API: bacnet` |
| Champ `physicsLocal` de l'état renvoyé | nœud `API: bacnet` |
| Bouton « Internal simulation » | `bacnet_conn_ui` |
| Textes qui renvoient au mode interne | `bacnet_conn_ui`, groupe `Sensor Simulation` |

`runPhysicsTick` reste exporté : le serveur de test en dépend.

### 1.3 Décider du démarrage à froid

Sans mode interne, un démarrage sans connexion n'a aucune donnée vivante — les
points gardent les valeurs initiales de `points.js`, figées.

Recommandation : **tenter automatiquement le serveur simulé au démarrage**
(`SIM_DEFAULTS`), et afficher clairement « aucune source connectée » en cas
d'échec. Sinon la première expérience d'un nouvel utilisateur est un bâtiment
gelé sans explication. Penser à `bms-sim-start` dans la documentation
d'installation.

### 1.4 Documentation à reprendre

`CLAUDE.md` (§ BACnet/IP), `packaging/UTILISATION.md`, `packaging/INSTALLATION.md`
— toutes mentionnent le mode interne comme défaut.

---

## 2. Profils COV

### Sémantique retenue

Un profil est une **table creuse unité → incrément**, pas un réglage scalaire :

```json
{ "name": "CO2 fin", "increments": { "ppm": 10 } }
```

Le profil « default » couvre toutes les unités et sert de socle :

| Unité | Incrément par défaut |
|---|---|
| °C | 0.2 |
| % | 2 |
| ppm | 25 |
| lux | 20 |
| bool | (toute transition) |

Un profil nommé n'a d'effet sur un point que s'il définit l'unité de ce point.
C'est pourquoi appliquer « CO2 fin » à une sélection de 40 points n'en touche
que les 8 en ppm — comportement correct, à énoncer clairement dans l'interface.

**Précédence** : surcharge par point → affectation par étiquette → défaut par
unité. L'affectation par étiquette est le mécanisme principal (les nouveaux
points héritent tout seuls) ; l'application en masse sert aux exceptions.

Un profil devrait porter plus que l'incrément :
- `minIntervalMs` — plafond de cadence, contre un capteur bavard ;
- `heartbeatMs` — re-notification périodique même sans changement, pour
  distinguer « rien n'a bougé » de « le lien est mort ».

### Interface

**Page BACnet** : section « CoV profiles » — édition du profil par défaut
(une ligne par unité) et création de profils nommés.

**Device & Tag Manager** : nouvelle colonne montrant l'incrément **effectif**
et sa **provenance** (`0.2 °C · défaut`, `10 ppm · tag:meeting`,
`0.5 °C · manuel`). Sans la provenance, personne ne peut expliquer pourquoi un
point se comporte autrement que son voisin. Menu déroulant pour la surcharge
par point.

Ajouter une colonne **notifications/min mesurée** (fenêtre glissante d'une
heure) : trier dessus est la façon concrète de trouver un point mal réglé.

**Application en masse** : bouton « appliquer un profil aux appareils visibles »
à côté des compteurs existants. Confirmation en distinguant **deux** nombres :

> Appliquer « CO2 fin » à **8 des 40** appareils visibles.
> 32 n'ont aucun point en ppm et ne sont pas concernés.
> ⚠ 3 des 8 portent déjà une surcharge manuelle, qui sera écrasée.

Le second nombre est le seul cas destructeur : il mérite une case à cocher
explicite, pas un écrasement silencieux.

### Côté serveur

`covIncrement` n'est pas encore posé sur les objets du simulateur — c'est
pourquoi le volume de notifications reste élevé (~20/s, la physique remue 86
points toutes les 2 s). À implémenter dans `buildObjects()`
(`lib/bacnet-sim/server.js`) et à transmettre à `subscribeCov` côté pilote.

---

## 3. Bonnes pratiques en outil, par thème

Remplacer le bloc de recommandations du prompt par un outil que le modèle
consulte à la demande : `read_guidance({ theme })`, plus une liste de thèmes
inspectable. Le prompt de base ne garde qu'un noyau de démarrage.

Thèmes proposés : *idempotence et déclenchement* · *machines à états et
hystérésis* · *étiquettes et commandes de groupe* · *minuteurs et ttl* ·
*widgets du dashboard* · *coûts propres à BACnet*.

**Partager le vocabulaire avec l'analyse statique** : un code d'avertissement
(`unguarded-rewrite`) doit nommer le thème qui l'explique, pour que le modèle
n'aille lire la version longue qu'en cas de besoin.

**Supprimer du prompt ce que l'analyseur détecte** plutôt que de le déplacer :
c'est là qu'est l'économie de contexte réelle. Les avertissements reviennent
désormais dans le résultat d'outil, donc l'assistant se corrige dans le tour.

---

## 4. Dettes connues

- **Régression** : depuis que `Safety Guard` écrit en asynchrone, les écritures
  **réussies** ne sont plus journalisées — seuls les échecs le sont. Le journal
  des commandes est donc aveugle, alors que c'est précisément là que la
  pathologie « Business Hours » aurait dû se voir. Corriger dans le chemin
  `io.write` ou dans la branche succès de `Safety Guard`.
- **Documentation française** : `INSTALLATION.md` et `UTILISATION.md` ne
  couvrent ni le mode BACnet, ni `bms-sim-start`, ni la page BACnet Server.
- **Reliquats P2 de l'audit** : humidité jamais simulée, `loc_timezone`
  décoratif, mode GPS mort, `tag_create` sans effet (devient important quand la
  table de métadonnées est la surface de configuration principale),
  `gap-N` → `ga-N`, horodatages figés dans l'Inspector.
- **Limites BACnet assumées** : pas de MS/TP (routeur IP requis), pas de
  segmentation sortante (RPM par lots de 12, appels sérialisés), capteurs non
  forçables via BACnet (par conception — utiliser le canal de contrôle du
  simulateur).

---

## Rappels d'outillage

- `node --test --test-concurrency=1 test/` avant **et** après toute
  modification du cœur.
- Éditer `flows.json` par `tools/flowkit.js`, jamais à la main : il valide le
  câblage et **échoue bruyamment** si un fragment de patch ne mord pas. Les
  patchs appliqués sont dans `tools/patches/`.
- Modifier `lib/` exige un **redémarrage** de Node-RED, pas un déploiement.
- Vérifier le rendu d'un widget : le Chromium de Playwright est en cache —
  `chrome --headless --no-sandbox --virtual-time-budget=15000 --dump-dom <url>`.
- Le lien symbolique `node_modules` du dépôt est nécessaire pour lancer le
  serveur BACnet depuis le dépôt (les tests le font).
