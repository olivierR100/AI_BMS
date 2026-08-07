#!/usr/bin/env bash
#
# AI BMS — Installateur pour Windows WSL (Ubuntu / Debian)
#
#   Usage :  ./install.sh [options]
#
#   Options :
#     --port <n>        Port d'écoute Node-RED           (défaut : 1880)
#     --userdir <chemin> Répertoire de travail Node-RED  (défaut : ~/.node-red)
#     --password <mdp>  Mot de passe de l'éditeur        (défaut : demandé, sinon "admin")
#     --no-seed         Ne pas charger la configuration de démonstration
#     --no-build-tools  Ne pas installer build-essential (compilation native)
#     --yes             Ne rien demander, accepter les défauts
#     --help            Afficher cette aide
#
# Le script installe : Node.js 20 (NodeSource), Node-RED 4.1.1 (npm global),
# les modules de palette et la pile BACnet/IP, puis déploie les flows, le cœur
# BMS (lib/) et la configuration AI BMS.
#
set -Eeuo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Constantes
# ─────────────────────────────────────────────────────────────────────────────
readonly NODE_MAJOR=20
readonly NODERED_VERSION="4.1.1"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=1880
USERDIR="${HOME}/.node-red"
ADMIN_PASSWORD=""
LOAD_SEED=1
BUILD_TOOLS=1
ASSUME_YES=0
SUPERVISED=0        # passe à 1 si un service systemd utilisateur est installé

# ─────────────────────────────────────────────────────────────────────────────
# Affichage
# ─────────────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step()  { printf '\n%s▶ %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
ok()    { printf '  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
info()  { printf '  %s·%s %s\n' "${C_DIM}" "${C_RESET}" "$*"; }
warn()  { printf '  %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
die()   { printf '\n%s✗ ERREUR :%s %s\n\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

trap 'die "échec ligne $LINENO. Relancez le script après correction — il est ré-exécutable."' ERR

# Affiche l'en-tête de ce fichier : toutes les lignes de commentaire qui
# suivent le shebang, jusqu'à la première ligne de code.
usage() {
    awk 'NR == 1 { next }
         /^#/    { sub(/^# ?/, ""); print; next }
                 { exit }' "${BASH_SOURCE[0]}"
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Arguments
# ─────────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)           PORT="${2:?--port requiert une valeur}"; shift 2 ;;
        --userdir)        USERDIR="${2:?--userdir requiert une valeur}"; shift 2 ;;
        --password)       ADMIN_PASSWORD="${2:?--password requiert une valeur}"; shift 2 ;;
        --no-seed)        LOAD_SEED=0; shift ;;
        --no-build-tools) BUILD_TOOLS=0; shift ;;
        --yes|-y)         ASSUME_YES=1; shift ;;
        --help|-h)        usage ;;
        *) die "option inconnue : $1  (--help pour l'aide)" ;;
    esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port doit être un nombre (reçu : $PORT)"

printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "${C_BOLD}" "${C_RESET}"
printf '%s║   AI BMS — installation PoC sur Windows WSL              ║%s\n'   "${C_BOLD}" "${C_RESET}"
printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "${C_BOLD}" "${C_RESET}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Vérifications préalables
# ─────────────────────────────────────────────────────────────────────────────
step "1/9  Vérification de l'environnement"

[[ ${EUID} -ne 0 ]] || die "ne lancez pas ce script avec sudo. Lancez-le en utilisateur normal ;
       il demandera sudo uniquement pour les paquets système."

if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    ok "WSL détecté"
else
    warn "WSL non détecté — le script devrait fonctionner sur toute Ubuntu/Debian."
fi

command -v apt-get >/dev/null 2>&1 || die "apt-get introuvable. Ce script vise Ubuntu/Debian.
       Sous une autre distribution, suivez INSTALLATION.md § « Installation manuelle »."

for f in flows.json settings.js package.json; do
    [[ -f "${SCRIPT_DIR}/${f}" ]] || die "fichier manquant dans l'archive : ${f}
       Lancez le script depuis le dossier décompressé de l'archive."
done
[[ -f "${SCRIPT_DIR}/lib/bms-core/index.js" ]] || die "lib/bms-core manquant dans l'archive.
       Le cœur du BMS y vit désormais ; sans lui le système ne démarre pas."
ok "fichiers de l'archive présents"

if ! curl -fsS --max-time 10 -o /dev/null https://deb.nodesource.com 2>/dev/null; then
    warn "accès réseau à deb.nodesource.com incertain — l'installation peut échouer."
fi

# Port déjà occupé ?
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
    die "le port ${PORT} est déjà utilisé. Arrêtez le service concerné,
       ou relancez avec :  ./install.sh --port 1881"
fi
ok "port ${PORT} libre"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Paquets système
# ─────────────────────────────────────────────────────────────────────────────
step "2/9  Paquets système (sudo requis)"

APT_PKGS=(curl ca-certificates gnupg openssl)
(( BUILD_TOOLS )) && APT_PKGS+=(build-essential python3)

MISSING=()
for p in "${APT_PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done

if (( ${#MISSING[@]} )); then
    info "à installer : ${MISSING[*]}"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
    ok "paquets installés"
else
    ok "tous les paquets requis sont déjà présents"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Node.js 20
# ─────────────────────────────────────────────────────────────────────────────
step "3/9  Node.js ${NODE_MAJOR}.x"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
    CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    if (( CURRENT_MAJOR >= NODE_MAJOR )); then
        ok "Node.js $(node -v) déjà installé"
        NEED_NODE=0
    else
        warn "Node.js $(node -v) trop ancien (minimum : ${NODE_MAJOR}.x) — mise à niveau"
    fi
fi

if (( NEED_NODE )); then
    info "ajout du dépôt NodeSource…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    ok "Node.js $(node -v) installé"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Node-RED
# ─────────────────────────────────────────────────────────────────────────────
step "4/9  Node-RED ${NODERED_VERSION}"

INSTALLED_NR=""
if command -v node-red >/dev/null 2>&1; then
    INSTALLED_NR="$(node -p "require('/usr/lib/node_modules/node-red/package.json').version" 2>/dev/null || echo '?')"
fi

if [[ "${INSTALLED_NR}" == "${NODERED_VERSION}" ]]; then
    ok "Node-RED ${NODERED_VERSION} déjà installé"
else
    [[ -n "${INSTALLED_NR}" ]] && warn "Node-RED ${INSTALLED_NR} présent — installation de ${NODERED_VERSION}"
    info "npm install -g node-red@${NODERED_VERSION} (2 à 4 minutes)…"
    sudo npm install -g --unsafe-perm --no-audit --no-fund "node-red@${NODERED_VERSION}" >/dev/null
    ok "Node-RED $(node -p "require('/usr/lib/node_modules/node-red/package.json').version") installé"
fi

NR_MODULES="/usr/lib/node_modules/node-red/node_modules"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Répertoire de travail
# ─────────────────────────────────────────────────────────────────────────────
step "5/9  Répertoire de travail : ${USERDIR}"

if [[ -e "${USERDIR}" ]] && [[ -n "$(ls -A "${USERDIR}" 2>/dev/null)" ]]; then
    BACKUP="${USERDIR}.backup-$(date +%Y%m%d-%H%M%S)"
    if (( ASSUME_YES )); then
        REPLY="o"
    else
        printf '  %s!%s %s existe déjà et n'"'"'est pas vide.\n' "${C_YELLOW}" "${C_RESET}" "${USERDIR}"
        printf '    Il sera sauvegardé sous %s\n' "${BACKUP}"
        read -r -p "    Continuer ? [o/N] " REPLY
    fi
    [[ "${REPLY}" =~ ^[oOyY]$ ]] || die "installation annulée par l'utilisateur."
    cp -a "${USERDIR}" "${BACKUP}"
    ok "sauvegarde créée : ${BACKUP}"
fi

mkdir -p "${USERDIR}/context/global"
ok "répertoire prêt"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Secrets et fichiers de configuration
# ─────────────────────────────────────────────────────────────────────────────
step "6/9  Configuration et secrets"

API_TOKEN="$(openssl rand -hex 32)"
CRED_SECRET="$(openssl rand -hex 32)"

if [[ -z "${ADMIN_PASSWORD}" ]]; then
    if (( ASSUME_YES )); then
        ADMIN_PASSWORD="admin"
        warn "mot de passe éditeur laissé au défaut : admin"
    else
        read -r -s -p "  Mot de passe de l'éditeur Node-RED (vide = « admin ») : " ADMIN_PASSWORD
        echo
        [[ -n "${ADMIN_PASSWORD}" ]] || { ADMIN_PASSWORD="admin"; warn "défaut retenu : admin"; }
    fi
fi

PASSWORD_HASH="$(ADMIN_PASSWORD="${ADMIN_PASSWORD}" node -e '
  const bcrypt = require(process.argv[1] + "/bcryptjs");
  process.stdout.write(bcrypt.hashSync(process.env.ADMIN_PASSWORD, 8));
' "${NR_MODULES}")"
[[ "${PASSWORD_HASH}" == \$2* ]] || die "génération du hash bcrypt impossible."
ok "hash du mot de passe généré"

cp "${SCRIPT_DIR}/flows.json"   "${USERDIR}/flows.json"
cp "${SCRIPT_DIR}/package.json" "${USERDIR}/package.json"
cp "${SCRIPT_DIR}/settings.js"  "${USERDIR}/settings.js"

# Cœur du BMS : chargé par settings.js via functionGlobalContext.bmsCore.
# Sans ce dossier, « Initialize System » s'arrête net et rien ne démarre.
rm -rf "${USERDIR}/lib"
cp -r "${SCRIPT_DIR}/lib" "${USERDIR}/lib"
ok "cœur BMS déployé ($(find "${USERDIR}/lib" -name '*.js' | wc -l) modules)"

# Substitution des marqueurs de settings.js. On passe par des variables
# d'environnement + Node pour éviter tout problème d'échappement sed
# (le hash bcrypt contient « / » et « $ »).
SETTINGS_FILE="${USERDIR}/settings.js" \
PASSWORD_HASH="${PASSWORD_HASH}" \
API_TOKEN="${API_TOKEN}" \
CRED_SECRET="${CRED_SECRET}" \
PORT="${PORT}" \
node -e '
  const fs = require("fs");
  const f = process.env.SETTINGS_FILE;
  let s = fs.readFileSync(f, "utf8");
  const before = s;

  s = s.replace("REPLACE_WITH_BCRYPT_HASH",      process.env.PASSWORD_HASH);
  s = s.replace("REPLACE_WITH_STATIC_API_TOKEN", process.env.API_TOKEN);
  s = s.replace(/\/\/credentialSecret: "a-secret-key",/,
                `credentialSecret: "${process.env.CRED_SECRET}",`);
  s = s.replace("uiPort: process.env.PORT || 1880",
                `uiPort: process.env.PORT || ${process.env.PORT}`);

  if (s === before) throw new Error("aucun marqueur substitué dans settings.js");
  for (const marker of ["REPLACE_WITH_BCRYPT_HASH", "REPLACE_WITH_STATIC_API_TOKEN"]) {
    if (s.includes(marker)) throw new Error("marqueur restant : " + marker);
  }
  fs.writeFileSync(f, s);
'
chmod 600 "${USERDIR}/settings.js"
ok "settings.js personnalisé (port, token, mot de passe, credentialSecret)"

# ─────────────────────────────────────────────────────────────────────────────
# 7. Modules de palette
# ─────────────────────────────────────────────────────────────────────────────
step "7/9  Modules de palette et pile BACnet (7 paquets)"

info "npm install dans ${USERDIR} (2 à 5 minutes)…"
( cd "${USERDIR}" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
    || die "npm install a échoué dans ${USERDIR}.
       Relancez manuellement pour voir l'erreur :  cd ${USERDIR} && npm install"

for m in @flowfuse/node-red-dashboard json-rules-engine node-cache node-red-node-openweathermap suncalc @bacnet-js/client @bacnet-js/device; do
    [[ -d "${USERDIR}/node_modules/${m}" ]] || die "module absent après installation : ${m}"
done
ok "7 modules installés et vérifiés (dont la pile BACnet/IP)"

# ─────────────────────────────────────────────────────────────────────────────
# 8. Configuration de démonstration
# ─────────────────────────────────────────────────────────────────────────────
step "8/9  Configuration de démonstration"

if (( LOAD_SEED )) && [[ -f "${SCRIPT_DIR}/seed/global.json" ]]; then
    cp "${SCRIPT_DIR}/seed/global.json" "${USERDIR}/context/global/global.json"
    ok "règles, états et widgets de démonstration chargés"
    info "(aucune clé d'API n'est incluse — à saisir dans l'onglet Settings)"
else
    printf '{}' > "${USERDIR}/context/global/global.json"
    ok "démarrage avec une configuration vide"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 9. Scripts de service et démarrage
# ─────────────────────────────────────────────────────────────────────────────
step "9/9  Scripts de gestion et premier démarrage"

BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"

# Node-RED réécrit le titre de son processus : pgrep sur la ligne de commande
# ne retrouve ni le --userDir ni le --port. On s'appuie donc sur un fichier de
# PID, avec repli sur le processus qui écoute le port.
cat > "${BIN_DIR}/bms-start" <<EOF
#!/usr/bin/env bash
# Démarre AI BMS en arrière-plan. Journal : /tmp/node-red.log
set -euo pipefail
PIDFILE="${USERDIR}/node-red.pid"

if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/bms/points" 2>/dev/null; then
    echo "AI BMS répond déjà sur le port ${PORT}."
    exit 0
fi
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
    echo "Le port ${PORT} est occupé par un autre service." >&2
    exit 1
fi

# cd dans le userDir : Node-RED résout \`flowFile\` depuis le répertoire courant.
# Lancé depuis un dossier contenant un autre flows.json, il chargerait celui-là.
cd "${USERDIR}"
nohup node-red --userDir "${USERDIR}" --port ${PORT} > /tmp/node-red.log 2>&1 &
echo \$! > "\${PIDFILE}"
echo "Démarrage… (journal : /tmp/node-red.log)"
for _ in \$(seq 1 45); do
    if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/bms/points" 2>/dev/null; then
        echo "AI BMS est prêt :  http://127.0.0.1:${PORT}/dashboard/"
        exit 0
    fi
    sleep 1
done
echo "Toujours pas de réponse après 45 s — consultez /tmp/node-red.log" >&2
exit 1
EOF

cat > "${BIN_DIR}/bms-stop" <<EOF
#!/usr/bin/env bash
# Arrête AI BMS proprement : le contexte fichier a le temps d'être écrit.
set -uo pipefail
PIDFILE="${USERDIR}/node-red.pid"

PID=""
if [[ -f "\${PIDFILE}" ]] && kill -0 "\$(cat "\${PIDFILE}")" 2>/dev/null; then
    PID="\$(cat "\${PIDFILE}")"
elif command -v ss >/dev/null 2>&1; then
    # Repli : le processus qui écoute le port.
    PID="\$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1)"
fi

if [[ -z "\${PID}" ]]; then
    echo "AI BMS n'est pas démarré."
    rm -f "\${PIDFILE}"
    exit 0
fi

kill "\${PID}" 2>/dev/null || true
for _ in \$(seq 1 20); do
    kill -0 "\${PID}" 2>/dev/null || { rm -f "\${PIDFILE}"; echo "Arrêté."; exit 0; }
    sleep 1
done
kill -9 "\${PID}" 2>/dev/null || true
rm -f "\${PIDFILE}"
echo "Arrêté (forcé)."
EOF

cat > "${BIN_DIR}/bms-log" <<'EOF'
#!/usr/bin/env bash
exec tail -f /tmp/node-red.log
EOF

cat > "${BIN_DIR}/bms-sim-start" <<EOF
#!/usr/bin/env bash
# Démarre le serveur BACnet/IP de test (le bâtiment simulé, sur le réseau).
set -euo pipefail
LOG=/tmp/bacnet-sim.log
PIDFILE=${USERDIR}/bacnet-sim.pid
if [[ -f "\${PIDFILE}" ]] && kill -0 "\$(cat "\${PIDFILE}")" 2>/dev/null; then
    echo "Le serveur BACnet de test tourne déjà (pid \$(cat "\${PIDFILE}"))."
    exit 0
fi
cd "${USERDIR}"
nohup node lib/bacnet-sim/server.js --port \${BACNET_SIM_PORT:-47810} \
      --device-id \${BACNET_SIM_DEVICE:-1234} > "\${LOG}" 2>&1 &
echo \$! > "\${PIDFILE}"
sleep 2
if kill -0 "\$(cat "\${PIDFILE}")" 2>/dev/null; then
    echo "Serveur BACnet de test démarré (journal : \${LOG})"
    head -3 "\${LOG}"
else
    echo "Échec du démarrage — voir \${LOG}" >&2; exit 1
fi
EOF

cat > "${BIN_DIR}/bms-sim-stop" <<EOF
#!/usr/bin/env bash
set -uo pipefail
PIDFILE=${USERDIR}/bacnet-sim.pid
if [[ -f "\${PIDFILE}" ]] && kill -0 "\$(cat "\${PIDFILE}")" 2>/dev/null; then
    kill "\$(cat "\${PIDFILE}")"; rm -f "\${PIDFILE}"; echo "Serveur BACnet de test arrêté."
else
    echo "Le serveur BACnet de test n'est pas démarré."; rm -f "\${PIDFILE}"
fi
EOF

cat > "${BIN_DIR}/bms-rotate-token" <<EOF
#!/usr/bin/env bash
# Régénère le jeton d'API Admin et le mot de passe de l'éditeur.
# À lancer avant toute exposition réseau, ou si un secret a fui.
set -Eeuo pipefail
SETTINGS="${USERDIR}/settings.js"
NR_MODULES="/usr/lib/node_modules/node-red/node_modules"
[[ -f "\${SETTINGS}" ]] || { echo "settings.js introuvable : \${SETTINGS}" >&2; exit 1; }

read -r -s -p "Nouveau mot de passe éditeur (vide = inchangé) : " NEWPASS; echo
NEWTOKEN="\$(openssl rand -hex 32)"

cp "\${SETTINGS}" "\${SETTINGS}.bak-\$(date +%Y%m%d-%H%M%S)"

SETTINGS="\${SETTINGS}" NEWTOKEN="\${NEWTOKEN}" NEWPASS="\${NEWPASS}" NR_MODULES="\${NR_MODULES}" node -e '
  const fs = require("fs");
  const f = process.env.SETTINGS;
  let s = fs.readFileSync(f, "utf8");

  const tokenRe = /(token:\s*")[^"]*(")/;
  if (!tokenRe.test(s)) throw new Error("jeton introuvable dans settings.js");
  s = s.replace(tokenRe, "\$1" + process.env.NEWTOKEN + "\$2");

  if (process.env.NEWPASS) {
    const bcrypt = require(process.env.NR_MODULES + "/bcryptjs");
    const hash = bcrypt.hashSync(process.env.NEWPASS, 8);
    const pwRe = /(password:\s*")[^"]*(")/;
    if (!pwRe.test(s)) throw new Error("mot de passe introuvable dans settings.js");
    s = s.replace(pwRe, "\$1" + hash + "\$2");
  }
  fs.writeFileSync(f, s);
'
chmod 600 "\${SETTINGS}"

ACCESS="${USERDIR}/ACCES.txt"
if [[ -f "\${ACCESS}" ]]; then
    sed -i "s|^Token Admin API .*|Token Admin API  \${NEWTOKEN}|" "\${ACCESS}"
fi

echo "Nouveau jeton : \${NEWTOKEN}"
echo "Redémarrez pour l'activer :  bms-stop && bms-start"
echo "Pensez à mettre à jour NODE_RED_TOKEN si vous utilisez le serveur MCP."
EOF

chmod +x "${BIN_DIR}"/bms-start "${BIN_DIR}"/bms-stop "${BIN_DIR}"/bms-log \
         "${BIN_DIR}"/bms-rotate-token "${BIN_DIR}"/bms-sim-start "${BIN_DIR}"/bms-sim-stop
ok "commandes créées : bms-start, bms-stop, bms-log, bms-rotate-token, bms-sim-start, bms-sim-stop"

# Supervision : systemd utilisateur si disponible (WSL2 récent avec systemd=true
# dans /etc/wsl.conf), sinon les scripts nohup ci-dessus font le travail.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT_DIR="${HOME}/.config/systemd/user"
    mkdir -p "${UNIT_DIR}"
    cat > "${UNIT_DIR}/ai-bms.service" <<EOF
[Unit]
Description=AI BMS (Node-RED)
After=network.target

[Service]
Type=simple
WorkingDirectory=${USERDIR}
ExecStart=$(command -v node-red) --userDir ${USERDIR} --port ${PORT}
Restart=on-failure
RestartSec=5
# Laisse le contexte fichier se vider avant de couper (flush toutes les 30 s).
KillSignal=SIGTERM
TimeoutStopSec=45

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if systemctl --user enable ai-bms.service >/dev/null 2>&1; then
        loginctl enable-linger "${USER}" >/dev/null 2>&1 || true
        ok "service systemd utilisateur installé et activé (ai-bms.service)"
        info "gestion : systemctl --user {start,stop,status} ai-bms"
        SUPERVISED=1
    else
        warn "unité systemd écrite mais non activée — utilisez bms-start"
    fi
else
    info "systemd utilisateur indisponible (cas courant sous WSL) — supervision par bms-start"
    info "pour un démarrage automatique, voir INSTALLATION.md § 4"
fi

# ~/.local/bin dans le PATH ?
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    if ! grep -qs 'HOME/.local/bin' "${HOME}/.bashrc"; then
        printf '\n# Ajouté par l'"'"'installateur AI BMS\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "${HOME}/.bashrc"
    fi
    warn "~/.local/bin ajouté au PATH — ouvrez un nouveau terminal, ou :  source ~/.bashrc"
fi

# Fiche récapitulative des accès
ACCESS_FILE="${USERDIR}/ACCES.txt"
cat > "${ACCESS_FILE}" <<EOF
AI BMS — accès (généré le $(date '+%Y-%m-%d %H:%M:%S'))
════════════════════════════════════════════════════════
Dashboard        http://127.0.0.1:${PORT}/dashboard/
Éditeur de flows http://127.0.0.1:${PORT}/
   utilisateur   admin
   mot de passe  (celui saisi à l'installation)

API BMS          http://127.0.0.1:${PORT}/bms   (sans authentification en local)
Token Admin API  ${API_TOKEN}
   usage : curl -H "Authorization: Bearer <token>" http://127.0.0.1:${PORT}/flows

Répertoire       ${USERDIR}
Journal          /tmp/node-red.log
Commandes        bms-start | bms-stop | bms-log

⚠ Ce fichier contient un secret. Ne le transmettez pas.
EOF
chmod 600 "${ACCESS_FILE}"
ok "récapitulatif des accès : ${ACCESS_FILE}"

# Premier démarrage + contrôle de santé
info "démarrage de Node-RED…"
if (( SUPERVISED )); then
    systemctl --user start ai-bms.service
else
    ( cd "${USERDIR}" && nohup node-red --userDir "${USERDIR}" --port "${PORT}" > /tmp/node-red.log 2>&1 & echo $! > "${USERDIR}/node-red.pid" )
fi

HEALTHY=0
for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/bms/points" 2>/dev/null; then
        HEALTHY=1; break
    fi
    sleep 1
done

if (( ! HEALTHY )); then
    warn "Node-RED n'a pas répondu en 60 s. Dernières lignes du journal :"
    tail -n 25 /tmp/node-red.log | sed 's/^/      /'
    die "démarrage incomplet. Diagnostiquez avec :  bms-log"
fi
ok "l'API BMS répond"

# Les états internes s'enregistrent une ou deux secondes après les points
# matériels : on laisse le système se stabiliser avant de le mesurer.
sleep 4
HEALTH=$(curl -fsS "http://127.0.0.1:${PORT}/bms/context" 2>/dev/null | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const hw = Object.keys(d.points.sensors).length
             + Object.keys(d.points.actuators).length
             + Object.keys(d.points.weather).length;
    console.log(`${hw} points matériels, ${Object.keys(d.virtualPoints).length} points virtuels`);
' 2>/dev/null || echo 'inventaire indisponible')
RULES=$(curl -fsS "http://127.0.0.1:${PORT}/bms/firelog" 2>/dev/null \
        | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).rulesLoaded ?? "?"' 2>/dev/null || echo '?')
ok "${HEALTH}"
ok "${RULES} règles chargées"

if [[ "${RULES}" == "0" ]] && (( LOAD_SEED )); then
    warn "aucune règle chargée alors que la configuration de démonstration a été copiée."
    warn "Consultez  curl -s http://127.0.0.1:${PORT}/bms/syslog?level=warn"
fi

printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
printf '%s║   Installation terminée                                  ║%s\n'   "${C_BOLD}${C_GREEN}" "${C_RESET}"
printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
cat <<EOF

  Dashboard   ${C_BOLD}http://127.0.0.1:${PORT}/dashboard/${C_RESET}
  Éditeur     ${C_BOLD}http://127.0.0.1:${PORT}/${C_RESET}   (admin / votre mot de passe)

  Gestion     bms-start · bms-stop · bms-log
  Accès       ${ACCESS_FILE}

  Suite : lisez ${C_BOLD}UTILISATION.md${C_RESET} pour les premiers scénarios.

EOF
