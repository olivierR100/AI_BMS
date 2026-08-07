# AI BMS — Installation sur Windows (WSL)

Ce document décrit l'installation complète du PoC sur un poste Windows, depuis
une machine vierge jusqu'au dashboard qui tourne.

Durée : **10 à 20 minutes**, dont l'essentiel en téléchargements.

---

## 1. Ce que vous installez

Un système de gestion technique de bâtiment (GTB) piloté par IA, tournant sur
Node-RED. Il n'y a **aucun matériel à raccorder** : le PoC embarque un
simulateur physique qui produit des températures, des taux de CO2, des
présences et une météo cohérents en continu.

| Élément | Détail |
|---|---|
| Runtime | Node-RED 4.1.1 sur Node.js 20 |
| Bâtiment simulé | 86 points BACnet, 13 zones sur 3 étages, 17 points virtuels |
| Configuration livrée | 7 agents de comportement, 130 règles, 37 états internes |
| Interfaces | Dashboard web, API HTTP, assistant IA conversationnel |

Deux couches à distinguer, car elles reviennent partout dans la documentation :

- **`bacnetPoints`** — le matériel (simulé ici, réel demain). C'est la frontière
  prévue pour brancher une vraie installation BACnet.
- **`bmsMetadata`** — la vue GTB : noms, étiquettes, zones, droits d'accès.

Tout accès à un point passe par l'abstraction globale `BMS`, et toute
modification de configuration par `BMS.applyConfig`. Cette discipline est ce qui
rend le PoC portable vers du matériel réel.

---

## 2. Prérequis côté Windows

### 2.1 Configuration minimale

- Windows 10 version 2004 ou ultérieure, ou Windows 11
- 4 Go de RAM libres, 2 Go d'espace disque
- Un accès Internet sans proxy filtrant (npm et NodeSource doivent être joignables)

### 2.2 Installer WSL2

Si WSL n'est pas déjà présent, ouvrez **PowerShell en administrateur** et lancez :

```powershell
wsl --install -d Ubuntu
```

Redémarrez le poste si Windows le demande. Au premier lancement d'Ubuntu, créez
un nom d'utilisateur et un mot de passe Linux — ce mot de passe sera demandé par
`sudo` pendant l'installation.

Vérifiez ensuite, toujours dans PowerShell :

```powershell
wsl -l -v
```

Vous devez voir `Ubuntu` en `VERSION 2`. Si la version affichée est 1 :

```powershell
wsl --set-version Ubuntu 2
```

### 2.3 Transférer l'archive dans WSL

Ouvrez un terminal **Ubuntu** (menu Démarrer → Ubuntu) et copiez l'archive
depuis votre dossier Windows. En remplaçant `VOTRE_NOM` par votre nom
d'utilisateur Windows :

```bash
cp /mnt/c/Users/VOTRE_NOM/Downloads/ai-bms-poc-*.tar.gz ~/
cd ~
tar xzf ai-bms-poc-*.tar.gz
cd ai-bms-poc-*/
```

> Le disque Windows est monté sous `/mnt/c`. À l'inverse, le système de fichiers
> Linux est accessible depuis l'explorateur Windows via `\\wsl$\Ubuntu\home\`.

**Travaillez toujours dans le système de fichiers Linux** (`~`), jamais
directement dans `/mnt/c`. Node.js y est plusieurs fois plus lent, et les
permissions de fichiers ne se comportent pas comme attendu.

---

## 3. Installation automatique

Depuis le dossier décompressé :

```bash
./install.sh
```

Le script demande votre mot de passe `sudo` (pour les paquets système) puis un
mot de passe pour l'éditeur Node-RED. Il déroule ensuite neuf étapes :

| Étape | Action |
|---|---|
| 1 | Vérifie l'environnement : WSL, apt, fichiers présents, port libre |
| 2 | Installe les paquets système (`curl`, `openssl`, `build-essential`…) |
| 3 | Installe Node.js 20 depuis NodeSource, si absent ou trop ancien |
| 4 | Installe Node-RED 4.1.1 globalement |
| 5 | Prépare `~/.node-red` (sauvegarde horodatée si le dossier existe déjà) |
| 6 | Génère les secrets, personnalise `settings.js`, déploie le cœur `lib/bms-core/` |
| 7 | Installe les 5 modules de palette et vérifie leur présence |
| 8 | Charge la configuration de démonstration |
| 9 | Crée les commandes `bms-*`, pose un service systemd si possible, démarre et contrôle la santé |

Le script est **ré-exécutable** : en cas d'échec, corrigez la cause et relancez-le.
Il ne détruit jamais un `~/.node-red` existant sans en faire une copie
`~/.node-red.backup-<horodatage>`.

### 3.1 Options

```bash
./install.sh --port 1881          # autre port d'écoute
./install.sh --userdir ~/bms-test # autre répertoire de travail
./install.sh --no-seed            # démarrer sans la configuration de démonstration
./install.sh --no-build-tools     # ne pas installer build-essential
./install.sh --yes                # non interactif (mot de passe éditeur : admin)
./install.sh --help
```

Plusieurs instances peuvent coexister, chacune avec son port et son répertoire :

```bash
./install.sh --userdir ~/bms-demo --port 1881
./install.sh --userdir ~/bms-dev  --port 1882
```

### 3.2 Résultat attendu

```
▶ 9/9  Scripts de gestion et premier démarrage
  ✓ commandes créées : bms-start, bms-stop, bms-log
  ✓ l'API BMS répond
  ✓ 86 points matériels, 18 points virtuels
  ✓ 130 règles chargées

  Dashboard   http://127.0.0.1:1880/dashboard/
  Éditeur     http://127.0.0.1:1880/   (admin / votre mot de passe)
```

Ces trois lignes de contrôle sont l'essentiel : **86 points matériels, 18 points
virtuels, 130 règles**. Un nombre de règles à 0 signifie que la configuration de
démonstration n'a pas été reprise — voir § 7.

Ouvrez ensuite <http://127.0.0.1:1880/dashboard/> dans votre navigateur Windows :
WSL2 redirige `localhost` automatiquement, il n'y a rien à configurer.

Un récapitulatif des accès, **contenant le jeton d'API Admin**, est écrit dans
`~/.node-red/ACCES.txt` (permissions 600). Ne le transmettez pas.

---

## 4. Piloter le service

Le script installe trois commandes dans `~/.local/bin` :

```bash
bms-start          # démarre en arrière-plan et attend que l'API réponde
bms-stop           # arrêt propre (laisse le contexte se vider sur disque)
bms-log            # suit /tmp/node-red.log en direct
bms-rotate-token   # régénère le jeton d'API et le mot de passe de l'éditeur
```

Si votre WSL exécute systemd, l'installateur pose en plus un service utilisateur
qui **redémarre automatiquement le service en cas de plantage** :

```bash
systemctl --user status ai-bms
systemctl --user restart ai-bms
```

Le script vous indique à l'installation lequel des deux modes est actif.

Si `bms-start` est introuvable juste après l'installation, rechargez votre
shell : `source ~/.bashrc`.

### Démarrage automatique à l'ouverture d'Ubuntu

WSL n'exécute pas systemd par défaut sur toutes les installations. Le plus
simple est d'ajouter à la fin de `~/.bashrc` :

```bash
curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:1880/bms/points 2>/dev/null \
    || bms-start >/dev/null 2>&1
```

(On teste la réponse de l'API plutôt que la présence d'un processus : Node-RED
réécrit le titre de son processus, ce qui rend `pgrep` peu fiable ici.)

Node-RED démarrera alors à la première ouverture d'un terminal Ubuntu.

> **Important** : Node-RED s'arrête quand WSL s'arrête. Fermer toutes les
> fenêtres Ubuntu, ou lancer `wsl --shutdown` depuis Windows, coupe le service.
> La configuration n'est pas perdue pour autant (voir § 6).

---

## 5. Configurations facultatives

### 5.1 Assistant IA — clé de fournisseur

L'assistant conversationnel fonctionne avec **Anthropic, OpenAI, DeepSeek ou
Mistral**. Aucune clé n'est fournie dans l'archive : chacun utilise la sienne.

1. Ouvrez le dashboard → page **AI Assistant**
2. Cliquez l'icône d'engrenage du panneau de chat
3. Choisissez le fournisseur, collez la clé, ajustez le nom du modèle
4. Enregistrez

Les clés sont stockées **en clair** dans le contexte fichier de Node-RED
(`~/.node-red/context/global/global.json`). C'est un choix délibéré du PoC :
elles restent visibles dans l'interface pour qu'on pense à les effacer avant de
transmettre la machine ou une sauvegarde. Le champ « modèle » est libre —
vérifiez auprès de votre fournisseur l'identifiant de modèle en vigueur, les
valeurs pré-remplies datent de la construction du PoC.

Sans clé, tout le reste fonctionne : dashboard, règles, simulation, API HTTP, et
la page **AI Configuration** qui produit un prompt à copier vers n'importe quel
assistant externe.

### 5.2 Météo réelle

Le PoC simule la météo par défaut. Pour utiliser des données réelles :

1. Créez une clé gratuite sur <https://openweathermap.org/api>
2. Ouvrez l'éditeur de flows (<http://127.0.0.1:1880/>, `admin` + votre mot de passe)
3. Double-cliquez le nœud **OpenWeatherMap** de l'onglet « AI BMS V12 »
4. Saisissez la clé et la ville, puis **Deploy**

La ville et les coordonnées se règlent aussi depuis la page **Settings** du
dashboard, qui alimente le calcul de position solaire.

### 5.3 Accès depuis un autre poste du réseau

Par défaut tout est ouvert sur `127.0.0.1` sans authentification pour l'API BMS.
Avant d'exposer la machine sur un réseau :

1. Le jeton Admin et le mot de passe éditeur sont déjà générés aléatoirement par
   l'installateur — ne les remplacez pas par des valeurs faibles.
2. Protégez l'API BMS en définissant une variable d'environnement avant de
   démarrer :

   ```bash
   export BMS_API_TOKEN="$(openssl rand -hex 32)"
   bms-start
   ```

   Les requêtes devront alors porter l'en-tête `x-bms-token`.
3. Publiez le port WSL vers le réseau Windows (PowerShell administrateur) :

   ```powershell
   netsh interface portproxy add v4tov4 listenport=1880 `
       connectaddress=(wsl hostname -I).Trim() connectport=1880
   ```

### 5.4 Intégration Claude Code

Le dossier `claude-code/` de l'archive contient de quoi piloter le PoC depuis
Claude Code : le fichier d'instructions projet, la déclaration du serveur MCP
Node-RED, et quatre commandes (`/bms-status`, `/bms-apply`, `/bms-debug`,
`/bms-simulate`).

```bash
mkdir -p ~/mon-projet-bms/.claude
cp claude-code/CLAUDE.md   ~/mon-projet-bms/
cp claude-code/mcp.json    ~/mon-projet-bms/.mcp.json
cp -r claude-code/commands ~/mon-projet-bms/.claude/
```

Le serveur MCP a besoin du jeton Admin, qui figure dans `~/.node-red/ACCES.txt` :

```bash
export NODE_RED_TOKEN="<jeton lu dans ACCES.txt>"
```

C'est facultatif : l'API HTTP suffit pour tout piloter.

> `CLAUDE.md` renvoie à `handover/` et `audit/`, arborescence du dépôt d'origine.
> Dans l'archive, ces documents sont regroupés sous `docs/` — ajustez les deux
> chemins si vous voulez que Claude Code les retrouve.

---

## 6. Ce qui persiste, ce qui ne persiste pas

| Donnée | Emplacement | Survit à un redémarrage ? |
|---|---|---|
| Flows (structure) | `~/.node-red/flows.json` | oui |
| Cœur du BMS | `~/.node-red/lib/bms-core/` | oui (fichiers sur disque) |
| Multiplicateur de vitesse du temps | contexte `file` | oui — **vérifiez qu'il est à 1×** |
| Agents, règles, états, widgets | `~/.node-red/context/global/global.json` | oui |
| Réglages IA et clés | idem | oui |
| Ville et coordonnées | idem | oui |
| Valeurs des capteurs et actionneurs | mémoire vive | **non** — réinitialisées |
| Historique de déclenchement | mémoire vive | **non** |

Le contexte fichier est écrit sur disque **toutes les 30 secondes**. Après un
changement de configuration important, laissez passer une demi-minute avant de
couper WSL brutalement — ou utilisez `bms-stop`, qui laisse le temps au vidage.

Pour sauvegarder une configuration :

```bash
cp ~/.node-red/context/global/global.json ~/ma-config-$(date +%F).json
```

Pour la restaurer : arrêtez le service, recopiez le fichier, redémarrez.

---

## 7. Diagnostic

Toujours commencer par le journal :

```bash
bms-log            # en direct
tail -50 /tmp/node-red.log
```

| Symptôme | Cause probable et remède |
|---|---|
| `install.sh` échoue en étape 3 | NodeSource injoignable (proxy, DNS). Testez `curl -I https://deb.nodesource.com`. |
| Étape 7, `npm install` échoue | Compilation native. Relancez `cd ~/.node-red && npm install` pour voir l'erreur, et vérifiez que `build-essential` est installé. |
| « le port 1880 est déjà utilisé » | Une instance tourne déjà : `bms-stop`. Sinon `ss -ltnp \| grep 1880`, ou installez sur un autre port. |
| Le dashboard ne s'ouvre pas depuis Windows | Vérifiez d'abord dans WSL : `curl -I http://127.0.0.1:1880/dashboard/`. Si cela répond, redémarrez WSL (`wsl --shutdown` puis rouvrez Ubuntu) pour rétablir la redirection localhost. |
| Dashboard vide, « no widgets » | Le rendu se réalimente tout seul en quelques secondes. Sinon rechargez la page (Ctrl+F5). |
| 0 règle chargée | Le contexte n'a pas été repris. Vérifiez que `~/.node-red/context/global/global.json` fait plusieurs dizaines de kilo-octets, puis redémarrez. |
| Une règle ne se déclenche jamais | Presque toujours un identifiant de fait erroné. Voir UTILISATION.md § « Vérifier », et `GET /bms/config` renvoie `unknownFacts`. |
| Températures figées | La physique est peut-être désactivée : `curl -s http://127.0.0.1:1880/bms/firelog \| grep physics`. Réactivez-la depuis la page Hardware Simulator. |
| « bmsCore introuvable » au démarrage | Le dossier `lib/` manque dans le répertoire de travail. Recopiez-le depuis l'archive (`cp -r lib ~/.node-red/`) et redémarrez. |
| Une modification de `lib/` reste sans effet | Ces modules sont chargés au démarrage : `bms-stop && bms-start`. Un déploiement depuis l'éditeur ne suffit pas. |
| Le temps file trop vite, les minuteries expirent seules | Le mode Démo/Test est resté accéléré — il survit aux redémarrages. Page **Demo / Test Mode**, bouton « Back to real time ». |

Journal d'exécution côté serveur, filtrable :

```bash
curl -s "http://127.0.0.1:1880/bms/syslog?level=warn&n=50"
```

> Ce journal ne contient **que** ce qui se passe côté serveur. Un problème
> d'affichage dans un widget du dashboard n'y apparaîtra jamais : il faut alors
> ouvrir la console du navigateur (F12).

---

## 8. Installation manuelle

Si vous n'utilisez pas le script — autre distribution, ou politique interne :

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Node-RED
sudo npm install -g --unsafe-perm node-red@4.1.1

# 3. Fichiers du PoC
mkdir -p ~/.node-red/context/global
cp flows.json settings.js package.json ~/.node-red/
cp seed/global.json ~/.node-red/context/global/global.json

# 4. Secrets — remplacez les deux marqueurs de settings.js
node -e 'console.log(require("/usr/lib/node_modules/node-red/node_modules/bcryptjs").hashSync("VOTRE_MOT_DE_PASSE", 8))'
openssl rand -hex 32     # jeton d'API Admin
# éditez ~/.node-red/settings.js :
#   REPLACE_WITH_BCRYPT_HASH      → le hash ci-dessus
#   REPLACE_WITH_STATIC_API_TOKEN → le jeton ci-dessus
chmod 600 ~/.node-red/settings.js

# 5. Modules de palette
cd ~/.node-red && npm install --omit=dev

# 6. Démarrage
node-red --userDir ~/.node-red --port 1880
```

---

## 9. Désinstallation

```bash
bms-stop
rm -rf ~/.node-red ~/.node-red.backup-*
rm -f  ~/.local/bin/bms-start ~/.local/bin/bms-stop ~/.local/bin/bms-log
sudo npm uninstall -g node-red     # facultatif
```

Retirez au besoin la ligne `PATH` ajoutée en fin de `~/.bashrc`.

---

## 10. Et ensuite

- **UTILISATION.md** — prise en main, scénarios et exemples exécutables
- **docs/BMS_CONFIG_SCHEMA.md** — schéma complet des configurations et de l'API
- **docs/AI_BMS_Project_Handover.md** — architecture détaillée du système
- **docs/2026-06-12_audit.md** — audit technique et limitations connues
