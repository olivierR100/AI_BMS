# AI BMS — Prise en main

Ce document part du principe que l'installation est faite et que le dashboard
répond. Sinon, reprenez INSTALLATION.md.

---

## 1. Démarrer, arrêter, observer

```bash
bms-start    # démarre et attend que l'API réponde
bms-stop     # arrêt propre
bms-log      # journal en direct
```

Puis, dans le navigateur Windows :

| Adresse | Usage |
|---|---|
| <http://127.0.0.1:1880/dashboard/> | Le dashboard — le point d'entrée normal |
| <http://127.0.0.1:1880/> | L'éditeur Node-RED — les entrailles du système |

Contrôle de santé en une commande :

```bash
curl -s http://127.0.0.1:1880/bms/firelog | head -c 300
```

---

## 2. Visite guidée du dashboard

Sept pages, dans l'ordre où elles se comprennent le mieux.

### Control Panel — l'écran d'exploitation
La vue « client » : les équipements du bâtiment, groupés par étage et par zone,
avec leurs valeurs en direct. Les interrupteurs et curseurs y sont actifs :
une lampe basculée à la main le reste jusqu'à ce qu'une règle en décide
autrement. Les groupes se replient. C'est la page à montrer en démonstration.

### Hardware Simulator — le bâtiment simulé
Le matériel simulé, capteur par capteur. On y force une présence, on pousse un
taux de CO2, on fait grimper une température — et l'on observe la réaction de
l'automatisme. Le simulateur physique tourne en continu (~2 s) : les valeurs
forcées dérivent ensuite naturellement.

C'est aussi ici qu'on désactive la physique pour geler le bâtiment pendant une
explication.

### Logic Inspector — pourquoi le système a fait cela
La page de diagnostic, et la plus utile une fois le PoC en main. Elle affiche
les agents de comportement, leurs groupes de règles, l'état de chaque règle, et
surtout **l'horodatage du dernier déclenchement** de chacune. Les états internes
(`st_*`) y sont visibles avec leur valeur courante.

Règle d'or du projet : **une règle qui n'apparaît pas ici avec un déclenchement
récent ne fonctionne pas**, quoi qu'en dise l'écran d'application.

### AI Assistant — la conversation
Le chat en langage naturel qui écrit lui-même la configuration. Détaillé au § 4.

### AI Configuration — le mode manuel
Deux panneaux. Le premier produit un prompt système complet, décrivant tout
l'inventaire du bâtiment, à copier dans n'importe quel assistant externe. Le
second reçoit le JSON en retour et l'applique. C'est le mode de secours quand on
ne veut pas confier de clé d'API au PoC.

### Device Manager — le référentiel
Noms, étiquettes et zones des points. Les étiquettes comptent : elles servent à
désigner des ensembles d'équipements dans les règles et dans les demandes faites
à l'IA (« tous les bureaux du 2e »).

### Demo / Test Mode — accélérer le temps
La page d'administration qu'on n'ouvre pas en exploitation. Elle contient le
**multiplicateur de vitesse du temps** : 1× (défaut) à 120×.

Le bâtiment fonctionne avec des constantes de temps réelles — la temporisation
d'inoccupation est de 15 minutes. Impossible à montrer en direct, et pénible à
éprouver quand on vient d'écrire un jeu de règles. À 60×, ces 15 minutes
s'écoulent en 15 secondes.

Tous les faits temporels dérivent d'une horloge système unique : heure, jour,
minute de la semaine, compteur des minuteurs, et position du soleil. Accélérer
cette horloge ne modifie aucune règle. La page affiche côte à côte l'heure
système et l'heure réelle, et rappelle en clair ce que devient la temporisation
d'inoccupation à la vitesse choisie.

Deux précautions :

- La physique et le moteur de règles continuent de tourner à leur cadence
  réelle. Au-delà de 10×, températures et CO2 prennent du retard sur l'horloge.
  Jusqu'à 10× pour observer un bâtiment se stabiliser ; 60× et plus pour sauter
  jusqu'à un événement programmé.
- **Le réglage survit à un redémarrage.** Une bannière d'avertissement s'affiche
  tant qu'on n'est pas à 1×. Vérifiez-la avant de conclure quoi que ce soit sur
  le comportement réel du bâtiment.

### Settings — le site
Ville et coordonnées du bâtiment. Elles alimentent la météo et le calcul de
position solaire (lever, coucher, hauteur du soleil), lequel est disponible
comme fait dans les règles.

---

## 3. Les concepts, en cinq minutes

Quatre objets composent une configuration. Ils s'empilent :

**Les points** sont les faits observables. Trois familles :

| Famille | Exemples | Écriture |
|---|---|---|
| Capteurs (51) | `f1_meet_motion`, `f2_off1_co2`, `f1_lobby_temp` | via le simulateur matériel |
| Actionneurs (33) | `f1_meet_lamp`, `f2_off1_vent`, `f1_lobby_temp_setpoint` | via la couche BMS |
| Météo (2) | `glob_outside_temp`, `glob_outside_lux` | par le service météo |

Plus 18 **points virtuels** calculés : l'heure (`glob_time_hour`), le soleil
(`sun_altitude`, `sun_is_daylight`), les consignes de référence
(`glob_comfort_sp` = 21 °C, `glob_eco_sp` = 16 °C), le site (`loc_city`…).

La convention de nommage se lit d'elle-même : `f2_off1_co2` = étage 2, bureau 1,
CO2.

**Les états** (`st_*`) sont la mémoire du système : `st_off_f2_1_occupied`,
`st_meet_co2_stage`, `st_lobby_occ_timer`. Ils portent une valeur par défaut et,
au besoin, un `ttl` en secondes au terme duquel ils y retombent seuls. **Seules
les règles les écrivent**, par des événements `set_state` — l'API les expose en
lecture uniquement.

**Les règles** sont des `si … alors`. Les conditions comparent des faits ; les
événements agissent :

| Type d'événement | Effet |
|---|---|
| `control_device` | écrit un actionneur |
| `control_group` | écrit tous les actionneurs portant une étiquette |
| `set_state` | écrit un état interne |

**Les agents de comportement** regroupent les règles par intention métier
(« Éclairage 1er étage », « Régulation thermique ») et s'activent ou se
désactivent d'un bloc.

### Ce que la configuration livrée sait déjà faire

7 agents, 130 règles :

- **Éclairage** par étage : détection de présence → allumage, avec une
  temporisation d'inoccupation de 15 minutes (état `st_timeout_office`).
- **Ventilation** par zone : paliers de CO2 — sous 650 ppm palier 0 (10 %),
  au-delà de 800 ppm palier 1 (40 %), au-delà de 1200 ppm palier 2 (80 %). Les
  seuils de descente sont volontairement plus bas que ceux de montée : cette
  hystérésis évite le battement.
- **Régulation thermique** : consigne de confort quand la zone est occupée,
  consigne éco sinon.

---

## 4. Piloter par la conversation

C'est l'objet du PoC : décrire une intention, obtenir une automatisation.

1. Dashboard → **AI Assistant**
2. Engrenage → fournisseur (Anthropic, OpenAI, DeepSeek ou Mistral), clé, modèle
3. Décrivez ce que vous voulez, en français

Exemples de demandes qui fonctionnent bien :

> « Éteins toutes les lumières du 3e étage après 20 h, sauf si quelqu'un est
> présent. »

> « Si le CO2 de la salle de réunion dépasse 1000 ppm pendant une réunion,
> pousse la ventilation au maximum et note-le. »

> « En hiver, quand il fait moins de 5 °C dehors, remonte la consigne des
> bureaux exposés au nord d'un degré. »

> « Explique-moi pourquoi la lampe du couloir du 1er est allumée en ce moment. »

L'assistant connaît l'inventaire complet du bâtiment. Il **converse d'abord** :
il pose des questions, propose, et n'applique la configuration que lorsque
l'intention est claire. Cette alternance conversation / application est
volontaire — un assistant qui écrit des règles au premier message se trompe de
bâtiment.

L'application passe par l'outil `apply_bms_config`, c'est-à-dire exactement le
même chemin que l'API HTTP : il n'y a pas de porte dérobée.

Le panneau **API Call Log**, sous le chat, montre les échanges bruts avec le
fournisseur — pratique pour comprendre un comportement inattendu.

### Après chaque application : vérifier

Ouvrez **Logic Inspector** et cherchez le nouvel agent. Ses règles
déclenchent-elles ? Si la configuration est appliquée mais que rien ne bouge,
c'est presque toujours un identifiant de fait erroné — voir § 6.

---

## 5. Piloter par l'API

Base : `http://127.0.0.1:1880/bms` — sans authentification en local.

| Requête | Rôle |
|---|---|
| `GET /context` | Inventaire complet et configuration courante |
| `GET /points` | Toutes les valeurs. `?id=x` pour une, `?tag=x` pour un filtre |
| `POST /points` | `{id, value}` écrit via la couche BMS ; `{id, value, simulate:true}` écrit le capteur simulé |
| `POST /config` | Applique une configuration |
| `GET /firelog` | Règles chargées et derniers déclenchements — **l'outil de vérification** |
| `GET /syslog` | Journal serveur. `?n=`, `?level=warn`, `?grep=` |
| `GET/POST /demomode` | Vitesse du temps. `{"multiplier": 60}` pour accélérer, `1` pour revenir au réel |
| `GET /commandlog` | Traçabilité des commandes. `?n=`, `?id=`, `?source=`, `?failed=true` |

### Qui a commandé quoi

Chaque changement de valeur d'un actionneur est journalisé avec son origine —
une règle, l'assistant IA, l'API, un geste opérateur. Les réécritures
identiques ne sont pas tracées : les règles réaffirment la même consigne à
chaque cycle et noieraient l'information utile.

```bash
curl -s "http://127.0.0.1:1880/bms/commandlog?id=f2_off1_vent&n=10"
```

C'est la réponse à « pourquoi cette vanne s'est-elle ouverte cette nuit ? ».

### Les quatre exemples fournis

Ils sont dans `examples/`, exécutables tels quels, et commentés en français.
Lancez-les dans l'ordre.

```bash
cd examples

./01-inventaire.sh     # découvrir : combien de points, de quel type, quoi tourne
./02-appliquer.sh      # appliquer une configuration, puis vérifier qu'elle vit
./03-scenario.sh       # jouer une journée de travail et observer les réactions
./04-nettoyer.sh       # retirer proprement ce que l'exemple 2 a ajouté
```

Sur un autre port, préfixez : `BMS=http://127.0.0.1:1881/bms ./01-inventaire.sh`

`02-appliquer.sh` applique `02-regle-etat.json`, un fichier volontairement
commenté : lisez-le, c'est le meilleur point de départ pour écrire la vôtre.

`03-scenario.sh` est celui qu'il faut voir tourner : il force une présence puis
une montée de CO2 dans un bureau, et l'on regarde l'éclairage, la ventilation et
la consigne réagir sans que personne ne les commande.

### Écrire une configuration à la main

```json
{
  "merge": true,
  "behavior_agents": [
    { "id": "agent_x", "name": "…", "description": "…",
      "category": "lighting|climate|security|energy|safety",
      "enabled": true, "rule_group": "rg_x" }
  ],
  "defined_states": [
    { "id": "st_x", "name": "…", "type": "number|boolean",
      "defaultValue": 0, "ttl": 7200, "description": "…" }
  ],
  "rule_groups": [
    { "id": "rg_x", "name": "…", "rules": [
      { "name": "…", "priority": 10,
        "conditions": { "all": [
          { "fact": "f1_lobby_motion", "operator": "equal", "value": true } ] },
        "event": { "type": "control_device",
                   "params": { "id": "f1_lobby_lamp", "value": true } } }
    ]}
  ]
}
```

**`"merge": true` n'est pas un détail.** Avec, les éléments sont ajoutés ou mis à
jour par identifiant. Sans, chaque section fournie **remplace intégralement** la
section correspondante — envoyer un seul agent efface les sept autres. Dans le
doute, mettez `merge`.

Opérateurs de conditions : `equal`, `notEqual`, `greaterThan`,
`greaterThanInclusive`, `lessThan`, `lessThanInclusive`, `in`, `notIn`,
`contains`. Et leurs variantes **fait contre fait**, pour comparer deux points
plutôt qu'un point et une constante : `greaterThanFact`, `lessThanFact`,
`equalFact`, `notEqualFact`, `greaterThanInclusiveFact`,
`lessThanInclusiveFact`.

```json
{ "fact": "f1_lobby_temp", "operator": "greaterThanFact",
  "value": { "fact": "f1_lobby_temp_setpoint", "add": 0.5 } }
```

Le `add` réalise une bande morte : la règle ne déclenche qu'à un demi-degré
au-dessus de la consigne, ce qui évite le battement autour du point d'équilibre.
Côté événement, `value_from_fact` prend la valeur d'un autre point plutôt qu'une
constante :

```json
{ "type": "control_device",
  "params": { "id": "f2_off1_temp_setpoint", "value_from_fact": "glob_comfort_sp" } }
```

### Supprimer des éléments

```json
{
  "merge": true,
  "remove_agents":  ["agent_x"],
  "remove_states":  ["st_x"],
  "remove_widgets": ["w_x"],
  "rule_groups": [
    { "id": "rg_x", "remove": true },
    { "id": "rg_y", "remove_rules": ["Nom exact de la règle"] }
  ]
}
```

Ces formes fonctionnent avec ou sans `merge`. À l'intérieur d'un groupe existant
en mode `merge`, les règles sont mises à jour **par leur nom** — renommer une
règle en crée donc une seconde. `"replace": true` sur un groupe en remplace tout
le contenu d'un coup.

---

## 6. Diagnostiquer une règle qui ne fait rien

Dans l'ordre, c'est presque toujours résolu à l'étape 2.

**1. La configuration a-t-elle été acceptée ?**

```bash
curl -s -X POST http://127.0.0.1:1880/bms/config \
     -H 'Content-Type: application/json' --data-binary @ma-config.json
```

Regardez `unknownFacts` dans la réponse. **Un tableau non vide est un échec**,
même si `applied` est rempli : les règles concernées sont chargées mais ne
déclencheront jamais, faute de trouver le fait. C'est le piège numéro un du
projet. La liste exacte des identifiants valides est dans `GET /bms/context`.

**2. La règle est-elle chargée ?**

```bash
curl -s http://127.0.0.1:1880/bms/firelog | grep -o '"rulesLoaded":[0-9]*'
```

Absente ? L'agent est peut-être désactivé, ou son `rule_group` pointe vers un
identifiant de groupe qui n'existe pas.

**3. A-t-elle déjà déclenché ?**

Le `fireLog` donne l'horodatage du dernier déclenchement de chaque règle. Jamais
déclenché = les conditions ne sont pas réunies. Reprenez chaque condition et
comparez à la valeur réelle :

```bash
curl -s "http://127.0.0.1:1880/bms/points?id=f1_meet_motion"
```

**4. Une autre règle la contredit-elle ?**

Deux règles peuvent écrire le même actionneur en sens inverse. Le `fireLog` les
montre alors déclencher toutes les deux, en alternance. Départagez-les par la
`priority`, ou en ajoutant à la plus permissive la condition qui manque.

**5. Le journal serveur dit-il quelque chose ?**

```bash
curl -s "http://127.0.0.1:1880/bms/syslog?level=warn&n=30"
```

> Rappel : ce journal ne voit que le serveur. Un widget qui s'affiche mal, un
> bouton qui ne répond pas — cela se diagnostique dans la console du navigateur
> (F12), jamais ici.

---

## 7. Trois démonstrations qui portent

**a. Le bâtiment se régule seul** — Control Panel ouvert sur le 2e étage,
`examples/03-scenario.sh` lancé à côté. Les curseurs de ventilation bougent
d'eux-mêmes à mesure que le CO2 monte, la lampe s'allume à la détection. Rien
n'a été commandé à la main.

**b. Une intention devient une automatisation** — AI Assistant : « Le week-end,
mets tous les bureaux en consigne éco et coupe la ventilation, sauf si quelqu'un
badge. » L'assistant pose ses questions, propose, applique. Puis Logic Inspector
pour montrer les règles nouvellement créées, avec leur nom en clair.

**c. Le système s'explique** — « Pourquoi la ventilation du bureau 1 du 2e est-elle
à 80 % ? » L'assistant lit l'état courant et remonte la chaîne causale :
CO2 mesuré → palier → règle → consigne de ventilation.

---

## 8. Limites connues

Le PoC est un démonstrateur, pas un produit. Les principales limites sont
documentées dans `docs/2026-06-12_audit.md`. À connaître avant de le montrer :

- L'humidité n'est pas simulée : les points `*_hum` restent figés.
- Le fuseau horaire est décoratif — tous les faits temporels suivent l'horloge
  du serveur.
- Le mode GPS de la page Settings est inopérant : renseignez une ville.
- Une étiquette créée sans être affectée à un point disparaît au rechargement.
- Les valeurs des capteurs ne survivent pas à un redémarrage — la configuration,
  si.

---

## 9. Aller plus loin

| Document | Contenu |
|---|---|
| `docs/BMS_CONFIG_SCHEMA.md` | Schéma de configuration et référence d'API complète |
| `docs/AI_BMS_Project_Handover.md` | Architecture du système, nœud par nœud |
| `docs/AI_BMS_history.md` | Genèse du projet et choix de conception |
| `docs/2026-06-12_audit.md` | Audit technique, limitations, pistes d'amélioration |

### Où vit le code

Le cœur du BMS n'est plus dans le flow : il est dans `lib/bms-core/` du
répertoire de travail (`~/.node-red/lib/bms-core/`), en fichiers JavaScript
ordinaires — tables de points, abstraction `BMS`, application de configuration,
couche pilote, garde-fous, constructeur de prompt. Le nœud « Initialize System »
n'est plus qu'un amorçage d'une trentaine de lignes.

> **Conséquence pratique** : modifier `lib/` demande un **redémarrage**
> (`bms-stop && bms-start`), pas un simple déploiement. `settings.js` charge ces
> modules au démarrage. Modifier les flows depuis l'éditeur reste un déploiement
> normal.

Si le dossier `lib/` manque, le système ne démarre pas et le journal l'indique
explicitement.

### Tests

Le dépôt d'origine embarque un harnais de non-régression :

```bash
node --test --test-concurrency=1 test/     # ~4 minutes
```

Il démarre une instance jetable et vérifie les comportements de référence —
éclairage sur présence, hystérésis CO2, consignes, application et suppression de
configuration, détection des faits inconnus, horloge du mode démo — plus des
tests unitaires du cœur sans Node-RED. À lancer avant et après toute
modification du cœur.

### Vers du matériel réel

La couche pilote est en place, même si un seul pilote existe pour l'instant (le
simulateur). Elle prévoit ce qui distingue une écriture simulée d'une écriture
réelle : `BMS.writeValueAsync` rend une promesse, `BMS.getStatus(id)` donne l'âge
et la qualité d'une valeur, et le choix du pilote se fait **point par point** —
de quoi piloter un vrai contrôleur au milieu de 85 points simulés plutôt que de
basculer tout le bâtiment d'un coup.

Trois garde-fous accompagnent cette bascule, inertes tant que tout est simulé :
traçabilité des commandes, limitation de la cadence de changement, et
approbation explicite (`"approved": true`) pour toute configuration commandant
des points réels.

### Modifier le système lui-même

Pour ajouter des points, changer la physique ou créer une page, c'est dans
l'éditeur Node-RED, onglet « AI BMS V12 (Physics Simulator) ». Deux conventions
à respecter, faute de quoi le PoC perd sa portabilité vers du matériel réel :

1. **Tout accès à un point passe par l'abstraction globale `BMS`** — jamais
   d'écriture directe dans `bacnetPoints` en dehors du simulateur matériel.
2. **Toute application de configuration passe par `BMS.applyConfig`** — c'est le
   point de passage unique, partagé par l'API, l'assistant IA et l'import manuel.
