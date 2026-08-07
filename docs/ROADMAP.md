# AI BMS — travaux en cours et prochaines étapes

État au 2026-08-07. Ce document est le relais entre sessions : il porte le
détail d'implémentation qu'un résumé de conversation perd.

Voir `CLAUDE.md` pour l'architecture, `audit/2026-06-12_audit.md` pour les
limitations connues, `packaging/` pour la distribution.

---

## Où en est le système

Déployé et vérifié : 126 tests verts (`node --test --test-concurrency=1 test/`),
Node-RED sur 1880, serveur BACnet de test sur 47810 (contrôle 47811).

| Brique | État |
|---|---|
| Cœur extrait dans `lib/bms-core/` | fait |
| Harnais de tests (scénarios + unitaires) | fait, 126 tests |
| Profils COV par abonnement (SubscribeCOVProperty) | fait, pire cas 6,1/s → 2,8/s |
| Taxonomie : étiquettes typées, zones, groupes | fait, 13 zones · 10 groupes |
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
1. ~~**Profils COV** (§ 2)~~ — **fait le 2026-08-07**. Le sujet du volume de
   notifications est refermé, mais pas comme prévu : les « ~20/s » annoncés
   étaient une estimation fausse (cf. § 2). Gain réel mesuré : ×2 avec le socle,
   ×5 avec un profil grossier, sur un bâtiment entier en convergence.
2. ~~**Taxonomie des étiquettes, zones et groupes** (§ 3)~~ — **fait le
   2026-08-07**. Le registre de zones est en place : c'est là que le § 4 posera
   les paramètres thermiques et les surfaces vitrées. Le renommage propage bien
   vers `covTagAssignments`.
3. **Modèle thermique 2C + bruit** (§ 4) — **prochaine étape**. Sans lui, aucun
   estimateur n'est vérifiable : les données ne contiendraient pas ce qu'on
   cherche à retrouver. À trancher en commençant : comment les paramètres par
   zone atteignent le processus du simulateur (cf. la couture en fin de § 3).
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

## 2. Profils COV — FAIT (2026-08-07)

Logique dans `lib/bms-core/cov.js`, API `GET/POST /bms/cov`, patch de flow dans
`tools/patches/10-cov-profiles.js` et `11-cov-capability-gating.js`, 38 tests de
plus (93 au total).

### Correction : les ~20/s n'ont jamais existé

La section d'origine annonçait « ~20/s, la physique remue 86 points toutes les
2 s ». C'était une **estimation théorique, et elle était fausse** : la boucle de
publication du serveur (étape 3 de `tick()`) ne rappelle `setValue` que si la
valeur arrondie au dixième a **changé**. Un point immobile ne produit donc
aucune notification, avec ou sans bande morte.

Mesures réelles, 40 s, les 13 zones poussées à 27 °C — le pire cas, tout le
bâtiment en convergence :

| Réglage | Notifications | Débit | Réduction |
|---|---|---|---|
| aucune bande morte (objets **et** abonnements) | 256 | **6,1/s** | — |
| socle : 0,2 °C · 2 % · 25 ppm · 20 lux | 120 | **2,8/s** | ×2,2 |
| socle, °C porté à 1,0 | 48 | **1,2/s** | ×5,3 |

Bâtiment au repos, mêmes conditions : ~0,5/s, et la bande morte n'y change
presque rien puisqu'il n'y a rien à supprimer.

Le socle divise donc le pire cas par **deux**, et un profil plus grossier par
**cinq**. C'est réel, mesuré, et bien plus modeste que ce que la spécification
laissait espérer — parce que le simulateur se flattait déjà lui-même.

**Là où le mécanisme compte vraiment, c'est en face de matériel réel** : un
automate n'a pas notre logique de publication sur changement, et une sonde à
0,05 °C de résolution frémit en permanence.

### Sémantique retenue

Un profil est une **table creuse unité → incrément**, pas un réglage scalaire :

```json
{ "name": "CO2 fin", "increments": { "ppm": 10 }, "minIntervalMs": 0, "heartbeatMs": 0 }
```

Le profil « default » couvre toutes les unités et sert de socle : °C 0,2 · % 2 ·
ppm 25 · lux 20 · bool (toute transition). Il ne peut pas être supprimé, et une
unité qui en disparaîtrait est rétablie à sa valeur par défaut — un point dont
l'unité n'est couverte par rien n'aurait aucune bande morte du tout.

Un profil nommé n'a d'effet sur un point que s'il définit l'unité de ce point :
appliquer « CO2 fin » aux 86 points n'en touche que **8**, ce que la
confirmation annonce explicitement.

**Précédence** : surcharge par point → affectation par étiquette (liste
**ordonnée**, première ligne trouvée gagne) → socle. La chaîne est parcourue
dans cet ordre et le premier profil qui définit l'unité gagne — pour l'incrément
comme pour la cadence. Une surcharge qui ne couvre pas l'unité du point laisse
donc passer la suite, et la provenance renvoyée dit la vérité (`default`) plutôt
que `manual`.

Supprimer un profil emporte ses affectations et ses surcharges : une référence
pendante serait un réglage fantôme, exactement ce qu'on ne diagnostique jamais.

### Où chaque réglage est réellement appliqué

**Correction d'une erreur de ma part** (2026-08-07) : j'avais écrit qu'il était
« impossible » de porter l'incrément dans l'abonnement, après avoir vu que
l'enveloppe `client.subscribeProperty()` de la bibliothèque n'a pas de paramètre
d'incrément. J'ai généralisé d'une limite de bibliothèque à une limite de
protocole, et c'était faux. **SubscribeCOVProperty transporte bien un
`covIncrement`** (étiquette de contexte 5), et SubscribeCOVPropertyMultiple en
place un par propriété surveillée.

C'est le bon mécanisme, et c'est celui qui est implémenté :

- `increment` → **SubscribeCOVProperty**, l'incrément dans la requête
  d'abonnement. Le serveur range l'enregistrement sous la clé
  *adresse du client + subscriberProcessIdentifier + objet + propriété*, avec une
  **valeur de référence propre à cet abonnement**. Deux superviseurs peuvent donc
  suivre le même capteur à des seuils différents sans se gêner — ce qu'écrire la
  propriété `COV_Increment` de l'objet ne permet pas, puisque cela vaudrait pour
  tout le monde à la fois. L'identifiant de processus est **stable par point**,
  donc réémettre une requête met l'abonnement à jour au lieu d'en empiler un
  second (vérifié : 86 abonnements, jamais 87).
- `minIntervalMs` et `heartbeatMs` → appliqués **côté BMS**, dans le pilote :
  SubscribeCOVProperty ne les transporte pas. Le plafond de cadence **retarde**
  un point bavard et conserve la dernière valeur reçue (rien n'est perdu, et
  jamais une valeur périmée livrée à la place d'une plus récente) ; le battement
  de cœur **relit** un point resté silencieux trop longtemps, ce qui est la seule
  façon honnête d'obtenir la même information d'un automate qui n'émet rien de
  lui-même. `SubscribeCOVPropertyMultiple` a un `maxNotificationDelay` proche du
  plafond de cadence — le jour où ce service sera encodable, la comparaison
  vaudra d'être refaite.

### Un service facultatif, donc une interface qui s'adapte

SubscribeCOVProperty est facultatif. Le pilote lit
**`Protocol_Services_Supported`** à la connexion et publie
`capabilities.covIncrementSettable` ; l'API le relaie, et les deux interfaces
**masquent les réglages d'incrément** quand l'appareil ne sait pas les recevoir,
en affichant pourquoi. Afficher des commandes sans effet serait pire que ne rien
afficher. Restent visibles dans tous les cas le plafond de cadence, le battement
de cœur (côté BMS) et la colonne notif/min (une mesure, pas un réglage).

Sans le service, le pilote retombe sur SubscribeCOV simple : on perd le réglage,
jamais les mesures. `--no-cov-property` fait jouer ce rôle au simulateur, et
trois tests couvrent ce chemin dégradé.

Le simulateur pose aussi les incréments par unité sur ses objets dès
`buildObjects()` : c'est ce que voient les clients en SubscribeCOV simple, et le
repli quand une requête ne porte pas d'incrément. `--no-cov-deadband` les remet à
zéro (c'est la première ligne du tableau ci-dessus).

### Ce qu'il a fallu contourner dans les bibliothèques

Deux contournements, tous deux confinés et commentés sur place. Ce sont les
points à revérifier à chaque montée de version.

1. **Côté client** — `@bacnet-js/client` sait encoder ET décoder l'incrément
   (`SubscribeProperty`, étiquette 5), mais son enveloppe publique appelle
   l'encodeur avec `covIncrementPresent = false` et jette au passage le
   `lifetime` qu'on lui passe. `lib/bms-core/drivers/cov-property.js` substitue
   l'encodeur le temps d'un appel, avec les deux arguments manquants, et vérifie
   son arité au chargement pour échouer bruyamment si la signature change.
2. **Côté serveur** — `@bacnet-js/device` répond « service non supporté » à
   SubscribeCOVProperty, et garde son client BACnet dans un champ privé sans
   accesseur. `lib/bacnet-sim/server.js` remplace `.default` du module client
   *avant* de charger le module device, pour que celui-ci construise une
   sous-classe qui se signale ; on peut alors remplacer son écouteur.
   `lib/bacnet-sim/cov-property.js` tient la vraie table d'abonnements.

**Non implémenté : SubscribeCOVPropertyMultiple.** La bibliothèque n'a aucun
encodeur pour ce service (contrairement au simple), et son
`ServicesSupportedBitString` est construit sur 40 bits alors que le service est
le bit 41 — il ne pourrait même pas être annoncé. L'implémenter demanderait
d'écrire à la main l'ASN.1 imbriqué de `listOfCOVSubscriptionSpecifications`.
Le service simple suffit à régler un incrément par point ; le multiple ne
ferait qu'économiser des requêtes (86 aujourd'hui) et apporterait
`maxNotificationDelay`.

**Deux pièges à connaître :**

- Le décodeur de la bibliothèque rend `covIncrement: 0` aussi bien pour
  « étiquette absente » que pour « incrément explicitement nul » : la distinction
  est perdue avant nous. Le simulateur tranche comme la norme le fait pour
  l'absence — repli sur le `COV_Increment` de l'objet — et notifie toute
  transition pour un binaire, où l'incrément n'a pas de sens.
- Les bitstrings de cette bibliothèque sont en poids **faible** d'abord dans sa
  représentation interne (elle retourne les octets à l'encodage comme au
  décodage, donc le fil reste conforme). Le décodage des capacités vérifie le bit
  ReadProperty, obligatoire, comme témoin : s'il ne ressort pas, c'est notre
  lecture qui est fausse, et le pilote le dit au lieu d'annoncer tranquillement
  que rien n'est supporté.

### Interface

**Page BACnet**, section « CoV Profiles » : édition du socle (une ligne par
unité), création et suppression de profils nommés, affectations par étiquette
avec réordonnancement, et trois compteurs — notifications/min tous points,
surcharges par point, réglages pas encore descendus dans l'appareil.

**Device & Tag Manager** : colonne « CoV increment » portant l'incrément
effectif **et sa provenance** (`0.2 °C · default`, `10 ppm · tag:meeting`,
`1.5 °C · manual`), avec menu déroulant de surcharge par point ; colonne
**notif/min** (fenêtre glissante d'une heure) **triable** — c'est la façon
concrète de trouver le point mal réglé au milieu de 86. La colonne et
l'application en masse disparaissent quand l'appareil n'accepte pas de réglage
d'incrément.

**Application en masse** aux appareils visibles, avec la confirmation à deux
nombres :

> Appliquer « CO2 fin » à **8 des 40** appareils visibles.
> 32 n'ont aucun point en ppm et ne sont pas concernés.
> ⚠ 3 des 8 portent déjà une surcharge manuelle, qui sera écrasée.

Le second nombre est le seul cas destructeur : il est derrière une case à cocher,
et sans elle les surcharges existantes sont conservées et comptées comme telles.

### Reste à faire, si le besoin apparaît

- **SubscribeCOVPropertyMultiple** (cf. ci-dessus) : encodeur à écrire.
- `Active_COV_Subscriptions` du simulateur ne montre que les abonnements de la
  bibliothèque, pas les nôtres — sa table interne est privée. Le canal de
  contrôle (`GET /covsubs`) donne la vue complète, et c'est ce que les tests
  interrogent.
- Aucune interface pour `pointStaleAfter` : le battement de cœur rafraîchit
  `lastSeen`, mais rien ne signale encore visuellement un point périmé.
- Les profils ne s'appliquent qu'aux points matériels ; les points virtuels ne
  passent pas par BACnet et n'ont donc pas de notion de bande morte.

---

## 3. Taxonomie des étiquettes, zones et groupes — FAIT (2026-08-07)

Logique dans `lib/bms-core/tags.js`, API `GET/POST /bms/tags`, patch de flow dans
`tools/patches/13-tag-taxonomy.js`, 33 tests de plus (126 au total).

État après migration du parc de démonstration :

| Nature | Compte | Contenu |
|---|---|---|
| `zone` | 13 | les 12 locaux + `External` |
| `function` | 12 | `temperature`, `co2`, `lighting`, `hvac_temp`… |
| `role` | 2 | `sensor`, `actuator` |
| `other` | 3 | `booking`, `schedule`, `weather` |
| groupes | 10 | 3 étages + 5 types de local + `Outside` + `Building` |

Les 9 étiquettes redondantes (`floor1..3`, `global`, `lobby`, `corridor`,
`meeting`, `office`, `storage`) sont **devenues des groupes** et ont disparu du
registre. Vérifié avant de le faire : la configuration vivante ne cite que
`lighting` et `hvac_temp`, deux fonctions — aucune règle ne s'appuyait sur un
étage ni sur un type de local, donc la conversion n'en casse aucune.

`Building` regroupe les trois étages, qui regroupent leurs zones : la hiérarchie
demandée existe, et `Building` développe bien 12 zones et 84 points.

### Ce qui a été retenu, et pourquoi

- **La zone est une étiquette comme les autres**, et `bmsMetadata[id].zone` reste
  un champ **dérivé**, recalculé au seul endroit qui l'écrit (`deriveZones`). Le
  moteur physique et l'analyseur continuent de lire `meta.zone` sans rien savoir
  du registre — le chemin chaud n'a pas bougé, et la physique retrouve ses
  13 zones.
- **La contrainte « une seule zone par point » est tenue dans le cœur**, pas
  seulement dans l'interface : affecter une zone en retire l'ancienne et le
  signale (`replaced`). Une API qui pourrait produire un état que l'interface
  interdit ne serait pas une contrainte, seulement une convention.
- **Un groupe est un libellé, une étiquette est un identifiant.** Les règles
  citent les étiquettes (`control_group`), donc elles gardent un jeu de
  caractères restreint et les espaces deviennent des soulignés. Les groupes ne
  servent qu'à filtrer et à s'afficher : « Façade sud » garde son accent et son
  espace.
- **Les garde-fous refusent plutôt qu'ils ne réparent** : supprimer une zone
  encore portée est refusé (avec le nombre de points qui se retrouveraient sans
  zone, et donc invisibles pour la physique) sauf forçage explicite ; retyper une
  étiquette en zone est refusé si un point en porterait deux ; un cycle de
  groupes est refusé avec le chemin fautif (`Floor 1 → Building → Floor 1`).
- **Renommer suit l'étiquette partout** : points, membres de groupes, et
  `covTagAssignments`. C'est la dépendance notée en refermant le § 2 — une
  affectation de profil COV laissée derrière serait un réglage fantôme.

### Dettes réglées au passage

- `tag_create` était sans effet (dette P2). Créer une étiquette a maintenant un
  sens : elle n'existe qu'avec un **type**, choisi dans l'interface.
- Le Device & Tag Manager était câblé en sortie, donc il ne recevait **pas** les
  messages entrants en direct (piège Dashboard 2.0 connu) : sa table était figée
  après le montage, et le rafraîchissement de 5 s tombait dans le vide. Il lit
  désormais `/bms/tags` lui-même. Le gestionnaire par topics
  (`device_tag_handler`), sans émetteur, a été retiré.

### Une couture à connaître pour le § 4

Le simulateur BACnet charge **sa propre copie** des tables de points, avec les
zones des littéraux de `points.js` — il ne passe pas par le registre. Rezoner un
point depuis l'interface change donc la vue du BMS (règles, analyseur, filtres)
mais **pas les murs du bâtiment simulé**. C'est sans conséquence aujourd'hui ;
cela en aura une au § 4, où les paramètres thermiques par zone devront atteindre
le processus du simulateur. Deux voies possibles à trancher à ce moment-là :
faire lire le registre au simulateur au démarrage, ou lui pousser la
configuration par son canal de contrôle.

### Constat d'origine

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

Les cinq étapes sont faites. La migration est **idempotente** (un second passage
ne trouve rien à reprendre) et une étiquette posée à la main hors interface est
rattrapée au démarrage suivant par la réconciliation, classée en `other` plutôt
qu'ignorée.

> La graine `packaging/seed/global.json` n'a **pas** été régénérée, et ce n'était
> pas nécessaire : la migration part de `bmsMetadata`, qui est reconstruit depuis
> les littéraux de `points.js` à chaque démarrage, puis fusionné avec ce qui est
> persisté. Elle ne dépend donc pas de l'état des règles dans la graine. Reste la
> décision du § 0 : ce que contient la configuration de démonstration livrée.

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
