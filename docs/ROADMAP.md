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
| Analyse statique des règles | fait, calibrée (25 avertissements sur la démo, tous fondés) |

---

## Ordre de travail convenu

Les dépendances comptent plus que les priorités : chaque étape est un prérequis
de la suivante.

0. **Le jeu de règles actuel est jetable** (décision du 2026-08-07). Aucune
   migration de règles à prévoir : les 135 règles produites par DeepSeek servent
   de cas d'étude à l'analyseur, pas de patrimoine. Cela retire la contrainte la
   plus lourde du § 3 — le registre d'étiquettes n'a pas à préserver les
   références de zone des règles existantes — et rend la régénération de la
   graine sans objet : il faudra plutôt **décider ce que contient la
   configuration de démonstration livrée** une fois les règles effacées.
1. **Profils COV** (§ 2) — indépendant, et referme le sujet du volume de
   notifications.
2. **Taxonomie des étiquettes, zones et groupes** (§ 3) — le registre de zones
   est l'endroit où vivront les paramètres thermiques et les surfaces vitrées.
3. **Modèle thermique 2C + bruit** (§ 4) — sans lui, aucun estimateur n'est
   vérifiable : les données ne contiendraient pas ce qu'on cherche à retrouver.
4. **Irradiance** (§ 5) — le solaire est le principal facteur de confusion de
   l'identification ; l'ajouter après coup fausserait les paramètres déjà tirés.
5. **Identification thermique** (§ 6), en commençant par le niveau 0, qui sert
   aussi de repli permanent.
6. **Localisation** (§ 7) et **bonnes pratiques en outil** (§ 8) — sans
   dépendance, à intercaler quand cela arrange.

---

## 1. Supprimer le mode « internal » — FAIT (2026-08-07)

Une seule source de points désormais : BACnet. Modes `simulated` | `real` |
`disconnected`.

- Harnais converti en premier : chaque exécution démarre son propre serveur
  BACnet (ports et device id tirés à part) et connecte le BMS en mode `real`.
  `client.sensor()` passe par le canal de contrôle du simulateur.
- Nœud `Physics Simulator` et son inject supprimés : la physique ne vit plus que
  dans le serveur BACnet.
- Connexion automatique au serveur simulé 8 s après le démarrage, avec garde :
  ne jamais écraser une connexion déjà établie.
- 55 tests verts, tous à travers BACnet.

Deux défauts trouvés au passage et corrigés :
- le portail d'approbation traitait les états internes (`st_*`) comme du
  matériel réel, et aurait exigé une approbation pour toute configuration en
  mode simulé. Il ne vise plus que `bacnetMode === 'real'` et les points
  réellement présents dans `bacnetPoints` ;
- droits d'accès, bornes et cadence n'étaient appliqués que sur la voie
  synchrone. Ils sont désormais dans `writeValueAsync`, avant le pilote — ce qui
  corrige aussi la régression du journal des commandes (les écritures réussies
  n'étaient plus tracées).

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

## 3. Taxonomie des étiquettes, zones et groupes — PRÉREQUIS au thermique

### Constat

La zone existe déjà et porte tout le travail de regroupement : le moteur
physique groupe sur `bmsMetadata[id].zone`, et le détecteur
`actuator-sensor-feedback` compare les zones de deux points. Mais elle est
**codée en dur** dans les littéraux de `lib/bms-core/points.js`, invisible et
non modifiable dans l'interface — et elle n'existe pas dans une table BACnet,
donc elle ne peut pas venir de l'automate.

Les étiquettes, elles, mélangent quatre natures : étages (`floor1`), types de
local (`lobby`, `meeting`), rôles (`sensor`, `actuator`) et fonctions
(`temperature`, `co2`, `lighting`). Les deux premières font doublon avec la zone.

### Cible

**Un type sur chaque étiquette.** Le registre d'étiquettes devient :

```json
{ "tag": "F1_Meeting",  "type": "zone" }
{ "tag": "temperature", "type": "function" }
{ "tag": "sensor",      "type": "role" }
{ "tag": "booking",     "type": "other" }
```

- `zone` — **exactement une par point** (un capteur n'est pas dans deux locaux).
  Contrainte à faire respecter par l'interface d'affectation, contrairement aux
  fonctions qui sont multiples.
- `function` — valeurs prédéfinies proposées avant saisie libre : `temperature`,
  `humidity`, `co2`, `iaq`, `motion`, `occupancy`, `light`, `lighting`,
  `hvac_temp`, `hvac_vent`, `setpoint`, `ventilation`.
- `role` — prédéfinies : `sensor`, `actuator`. Extensible.
- `other` — le reste (`booking`, `schedule`…).

**Groupes de zones, hiérarchiques.** Bouton « créer un groupe de zones » : un
groupe rassemble des zones *et d'autres groupes*. « Étage 1 » regroupe les zones
du niveau ; « Façade sud » regroupe des zones de plusieurs étages ; « Bâtiment »
regroupe les étages. Un groupe est utilisable en filtre au même titre qu'une
zone. Prévoir la détection de cycle à la création.

**Filtre du Device & Tag Manager** trié par nature : *Zones* · *Groupes* ·
*Fonctions* · *Rôles* · *Autres*. La zone reste affichée dans sa propre colonne
de la liste des appareils.

### Migration — le point délicat

Rendre la zone modifiable ne doit pas casser les deux consommateurs actuels.

Approche recommandée : **la source de vérité devient l'étiquette de type `zone`,
et `bmsMetadata[id].zone` reste un champ DÉRIVÉ**, recalculé à chaque
modification d'étiquette. Le moteur physique et l'analyseur continuent de lire
`meta.zone` sans changement — chemin chaud simple, migration réduite, et un seul
endroit où la vérité est écrite.

Étapes :
1. Ajouter le registre d'étiquettes typées (contexte `tagRegistry`, persisté
   dans le magasin `file`).
2. Générer les étiquettes de type `zone` depuis les `zone:` existants des 86
   points ; classer les étiquettes actuelles (`floor*`, types de local → à
   retirer une fois les groupes en place ; `sensor`/`actuator` → `role` ; le
   reste → `function` ou `other`).
3. Exposer la modification dans le Device & Tag Manager, avec recalcul de
   `meta.zone` à chaque affectation.
4. `tag_create` est aujourd'hui sans effet (dette P2) — à corriger dans le même
   mouvement, puisque la création d'étiquette devient centrale.
5. Vérifier après migration : le moteur physique doit toujours découvrir 13
   zones, et les 55 tests rester verts.

> Ne pas oublier : `packaging/seed/global.json` est **périmé** par rapport à la
> configuration vivante (41 états / 135 règles contre 37 / 130 — la logique de
> préconditionnement a été ajoutée depuis). La régénérer avant toute migration,
> sinon la migration porterait sur un état obsolète.

---

## 4. Modèle thermique du simulateur — PRÉREQUIS à l'identification

Le modèle actuel est **1C sans masse**, avec une constante de temps d'environ
**14 minutes** :

```
dT/dt = clamp(0,4·erreur, ±0,25) − 0,0024·(T − T_ext)     par tick de 2 s
```

Conséquence : le préconditionnement de 120 minutes porte sur ~8,6 constantes de
temps. Le bâtiment simulé est stabilisé bien avant, donc la fonction est
**inobservable** en simulation, et un estimateur 2C ajusté sur ces données
estimerait un paramètre que les données ne contiennent pas.

### Cible : 2C par zone

- **Nœud air** : τ ≈ 15–30 min, couplé au CVC et à la masse.
- **Nœud masse** : τ ≈ 10–50 h, couplé à l'air et à l'extérieur.
- Paramètres stockés dans le registre de zones (cf. § 3).

**Bruit — deux natures à ne pas confondre :**
- *bruit de mesure* : blanc, quelques centièmes de degré, ajouté à la lecture,
  ne s'accumule pas ;
- *bruit de procédé* : marche aléatoire de faible amplitude sur le nœud masse,
  représentant les apports non modélisés (occupants, équipements, portes).
  **C'est celui-ci qui rend l'identification réaliste.**
- Quantifier les lectures au dixième de degré, comme un capteur réel : cela seul
  pose un plancher d'identifiabilité.

### Apports internes — occupants

Demandé le 2026-08-07 : quand le capteur de présence d'une zone est vrai,
supposer **1 à 4 personnes** présentes tant qu'il l'est, et injecter leur apport
thermique.

**À traiter dans cette section, pas avant.** Le modèle actuel n'a aucune
capacité thermique : il n'existe aucun moyen honnête de convertir des watts en
degrés par tick. Ajouter les occupants au modèle 1C actuel reviendrait à
inventer un coefficient arbitraire. Une fois le nœud air et le nœud masse posés
avec des capacités réelles (J/K), l'apport devient une puissance qui s'ajoute
naturellement au bilan du nœud air.

**Sur la valeur de 300 W par personne** : c'est environ deux à trois fois le
métabolisme d'une personne assise en activité légère (ordre de grandeur usuel :
~70 W sensible + ~45 W latent, soit ~115 W au total). 300 W correspond plutôt à
**une personne AVEC son poste de travail** — écran, portable, quote-part
d'éclairage et d'alimentation. Si c'est l'intention, la valeur est raisonnable
et il faut nommer le paramètre en conséquence (`occupant_plus_equipment_w`)
plutôt que de laisser croire à un métabolisme. Sinon, retenir ~120 W pour la
personne et modéliser les équipements séparément — ils chauffent aussi quand la
zone est vide.

Seul l'apport **sensible** élève la température ; la part latente joue sur
l'humidité, qui n'est pas simulée (dette P2). Le noter pour ne pas se surprendre
plus tard.

Nombre d'occupants : tirer un entier stable entre 1 et 4 par épisode de présence
(pas un tirage à chaque tick, qui produirait un bruit blanc irréaliste), et le
conserver tant que la présence dure. C'est aussi un apport que l'estimateur
thermique devra encaisser sans le connaître — exactement le rôle du bruit de
procédé décrit plus haut.

**Vitesse** : avec une masse à 20 h, le multiplicateur du mode Démo/Test cesse
d'être un confort et devient nécessaire pour observer quoi que ce soit.

---

## 5. Irradiance solaire

### Géométrie

- Orientation principale du bâtiment (azimut), réglée une fois.
- Par zone : surface vitrée à 0°, 90°, 180°, 270° **relativement** à cette
  orientation. Stocké dans le registre de zones.
- Position solaire déjà disponible (suncalc + lat/lon). L'irradiance incidente
  par façade s'obtient en séparant le global en direct et diffus, puis en
  projetant le direct selon l'angle d'incidence.
- S'en tenir là : ni masques, ni facteurs de forme, ni albédo.

### Sources de données — à VÉRIFIER avant de s'engager

| Source | Usage | Confiance |
|---|---|---|
| **Open-Meteo** | irradiance courante + prévision court terme, gratuit, sans clé | la plus prometteuse |
| **PVGIS** (Commission européenne) | séries historiques / TMY pour le simulateur | bonne |
| OpenWeatherMap (déjà intégré) | nébulosité ; l'irradiance ne semble pas offerte en gratuit | à vérifier |

À savoir : `glob_outside_lux` est aujourd'hui **synthétisé** depuis la
nébulosité dans le nœud « Parse & Update ». Le remplacer par une irradiance
mesurée est un petit changement à fort effet — tous les termes solaires en
dépendent.

La **prévision à ~2 h** vaut plus que la précision du modèle : savoir qu'une
façade sud va recevoir 700 W/m² dans deux heures pèse davantage qu'une capacité
thermique bien ajustée. C'est là qu'est le gain sur la surchauffe estivale.

---

## 6. Identification thermique — hiérarchie de modèles

Trois niveaux, publiés derrière **la même interface**.

**Niveau 0 — départ optimisé auto-apprenant (à faire en premier).**
Pas de modèle. Durée de préchauffage préréglée, capture de la température
atteinte en fin de préchauffage dans une variable, et une règle ajuste
progressivement la durée. C'est la méthode des GTB commerciales depuis des
décennies, et c'est aussi le repli quand l'estimateur n'a pas de données.

**Niveau 1 — 1C.** Constante de temps et gain de chauffe identifiés sur les
périodes en évolution libre (nuits, week-ends, CVC à l'arrêt), où la décroissance
vers l'extérieur donne τ directement.

**Niveau 2 — 2C + prévision.** Air et masse séparés, avec prévision de
température extérieure et apports solaires au prorata des surfaces vitrées et de
leur orientation.

### Identifiabilité — à garder en tête

Avec seulement T_int, T_ext et la commande CVC, on identifie de façon fiable
**une constante de temps dominante et un gain**. Séparer air et masse exige soit
une seconde mesure, soit des données couvrant proprement les deux échelles de
temps. Un 2C ajusté sur des données de 1C renvoie des valeurs confiantes et
fausses.

Le solaire est le principal facteur de confusion : sans irradiance, l'estimateur
le repliera silencieusement dans le gain de chauffe.

Les zones fuient les unes dans les autres : un modèle mono-zone absorbe cela
dans des paramètres effectifs — acceptable pour un départ optimisé, faux dès que
deux zones voisines suivent des horaires différents.

### Exposition à l'IA — publier le RÉSULTAT, pas le modèle

Ni valeurs R/C brutes (un modèle de langage raisonne mal dessus), ni appel
d'outil (inutilisable dans une condition de règle).

Un **point virtuel par zone** — `f1_lobby_precondition_start` — calculé en
continu, que le moteur de règles compare à `glob_time_minutes` avec le
vocabulaire existant :

```json
{ "fact": "glob_time_minutes", "operator": "greaterThanInclusiveFact",
  "value": { "fact": "f1_lobby_precondition_start" } }
```

Aucun concept nouveau pour le moteur, rien à enseigner au prompt. Publier à côté
un **indice de confiance** par zone, et **retomber automatiquement** sur
`st_precondition_lead_minutes` quand la confiance est faible : un bâtiment qui ne
chauffe pas parce qu'un estimateur était trop sûr de lui est bien pire qu'un
bâtiment qui préchauffe trente minutes trop tôt.

---

## 7. Localisation de l'interface

L'interface est en anglais, la documentation de déploiement en français, et les
commentaires du code en français. Décider d'une politique, puis l'appliquer.

- Extraire les libellés de l'interface dans un dictionnaire par langue plutôt
  que de les laisser en dur dans les `ui-template`.
- Langue choisie dans la page Settings, persistée dans le magasin `file`.
- Commencer par fr/en. Prévoir que les messages issus du moteur (avertissements
  de l'analyseur, erreurs de l'API) sont aujourd'hui en français dans le code et
  en anglais dans le prompt IA — trancher.
- Ne pas traduire les identifiants de points, d'étiquettes ni de règles : ce
  sont des clés, pas du texte.

## 8. Bonnes pratiques en outil, par thème

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

## 9. Dettes connues

- **Graine périmée** : `packaging/seed/global.json` (37 états / 130 règles) est en
  retard sur la configuration vivante (41 / 135, préconditionnement inclus).
  À régénérer avec `node packaging/tools/mkseed.js`.
- **Documentation française** : `INSTALLATION.md` et `UTILISATION.md` ne
  couvrent ni le mode BACnet, ni `bms-sim-start`, ni la page BACnet Server.
- **Reliquats P2 de l'audit** : humidité jamais simulée, `loc_timezone`
  décoratif, mode GPS mort, `tag_create` sans effet (devient important quand la
  table de métadonnées est la surface de configuration principale),
  `gap-N` → `ga-N`, horodatages figés dans l'Inspector.
- **Rétroaction éclairage** : les 11 règles « Actif+Sombre → lampe allumée » se
  conditionnent sur le luxmètre de la zone qu'elles éclairent. Non corrigées
  (le jeu de règles de démonstration est laissé tel quel, c'est le cas d'école
  du détecteur `actuator-sensor-feedback`), mais à reprendre avant une
  démonstration : une lampe éteinte à la main pendant l'occupation ne se
  rallume pas tant que le lux n'a pas rebaissé.
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
