#!/usr/bin/env bash
#
# build-archive.sh — construit l'archive de distribution AI BMS.
#
#   ./packaging/build-archive.sh [--no-seed-refresh]
#
# Produit  dist/ai-bms-poc-<date>.tar.gz  contenant tout ce qui n'est pas
# téléchargeable publiquement : les flows, les settings, la configuration de
# démonstration et la documentation. Node.js, Node-RED et les modules de
# palette sont récupérés par install.sh depuis npm / NodeSource.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="${REPO_ROOT}/packaging"
STAMP="$(date +%Y%m%d)"
NAME="ai-bms-poc-${STAMP}"
STAGE="$(mktemp -d)/${NAME}"
OUT_DIR="${REPO_ROOT}/dist"

REFRESH_SEED=1
[[ "${1:-}" == "--no-seed-refresh" ]] && REFRESH_SEED=0

trap 'rm -rf "$(dirname "${STAGE}")"' EXIT

echo "▶ Construction de ${NAME}"

# 1. Rafraîchir la graine depuis le contexte vivant, si disponible.
if (( REFRESH_SEED )) && [[ -f "${HOME}/.node-red/context/global/global.json" ]]; then
    node "${PKG_DIR}/tools/mkseed.js" >/dev/null
    echo "  · graine régénérée depuis le contexte vivant"
fi

mkdir -p "${STAGE}"/{seed,docs,examples,claude-code}

# 2. Runtime : les fichiers que l'installateur déploie tels quels.
#    settings.js vient du dépôt : c'est la version expurgée, avec les
#    marqueurs REPLACE_WITH_* que install.sh substitue.
cp "${REPO_ROOT}/flows.json"    "${STAGE}/flows.json"
cp "${REPO_ROOT}/settings.js"   "${STAGE}/settings.js"
cp "${REPO_ROOT}/package.json"  "${STAGE}/package.json"
cp "${PKG_DIR}/seed/global.json" "${STAGE}/seed/global.json"

# Cœur du BMS : settings.js le charge via functionGlobalContext.bmsCore.
cp -r "${REPO_ROOT}/lib" "${STAGE}/lib"

# 3. Installateur et documentation destinée au destinataire.
cp "${PKG_DIR}/install.sh"       "${STAGE}/install.sh"
cp "${PKG_DIR}/README.md"        "${STAGE}/README.md"
cp "${PKG_DIR}/INSTALLATION.md"  "${STAGE}/INSTALLATION.md"
cp "${PKG_DIR}/UTILISATION.md"   "${STAGE}/UTILISATION.md"
chmod +x "${STAGE}/install.sh"

# 4. Documentation de référence du projet.
cp "${REPO_ROOT}/docs/BMS_CONFIG_SCHEMA.md"          "${STAGE}/docs/"
cp "${REPO_ROOT}/docs/AI_BMS_history.md"             "${STAGE}/docs/"
cp "${REPO_ROOT}/handover/AI_BMS_Project_Handover.md" "${STAGE}/docs/"
cp "${REPO_ROOT}/audit/2026-06-12_audit.md"          "${STAGE}/docs/"

# 5. Exemples exécutables.
cp -r "${PKG_DIR}/examples/." "${STAGE}/examples/"
chmod +x "${STAGE}"/examples/*.sh 2>/dev/null || true

# 6. Intégration Claude Code (facultative pour le destinataire).
cp "${REPO_ROOT}/CLAUDE.md" "${STAGE}/claude-code/CLAUDE.md"
cp "${REPO_ROOT}/.mcp.json" "${STAGE}/claude-code/mcp.json"
cp -r "${REPO_ROOT}/.claude/commands" "${STAGE}/claude-code/commands"

# 7. Contrôles avant empaquetage : aucun secret ne doit partir.
echo "▶ Contrôle des secrets"
LEAKS=0
if grep -rlEi 'sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}' "${STAGE}" 2>/dev/null | grep -q .; then
    echo "  ✗ clé d'API détectée dans la mise en scène" >&2; LEAKS=1
fi
if grep -q 'REPLACE_WITH_BCRYPT_HASH' "${STAGE}/settings.js" \
&& grep -q 'REPLACE_WITH_STATIC_API_TOKEN' "${STAGE}/settings.js"; then
    echo "  ✓ settings.js est bien la version expurgée (marqueurs intacts)"
else
    echo "  ✗ settings.js ne contient pas les marqueurs — version vivante copiée par erreur ?" >&2
    LEAKS=1
fi
if [[ -e "${STAGE}/flows_cred.json" ]]; then
    echo "  ✗ flows_cred.json ne doit jamais être distribué" >&2; LEAKS=1
fi
# Le cœur doit être complet : settings.js le require au démarrage.
if [[ -f "${STAGE}/lib/bms-core/index.js" ]] && [[ $(find "${STAGE}/lib/bms-core" -name '*.js' | wc -l) -ge 9 ]]; then
    echo "  ✓ lib/bms-core complet ($(find "${STAGE}/lib/bms-core" -name '*.js' | wc -l) modules)"
else
    echo "  ✗ lib/bms-core incomplet — l'installation ne démarrerait pas" >&2; LEAKS=1
fi
if node -e '
    const s = require(process.argv[1]);
    const bad = Object.entries(s.aiChatSettings?.keys ?? {}).filter(([, v]) => v);
    if (bad.length) { console.error("  ✗ clés LLM non vidées : " + bad.map(([k]) => k)); process.exit(1); }
' "${STAGE}/seed/global.json"; then
    echo "  ✓ graine sans clé d'API"
else
    LEAKS=1
fi
(( LEAKS == 0 )) || { echo "▶ ABANDON : l'archive contiendrait des secrets." >&2; exit 1; }

# 8. Empaquetage.
mkdir -p "${OUT_DIR}"
ARCHIVE="${OUT_DIR}/${NAME}.tar.gz"
# Format tar.gz uniquement : il préserve le bit exécutable de install.sh, ce
# qu'un ZIP perdrait. Windows 11 et WSL savent tous deux l'ouvrir.
tar -czf "${ARCHIVE}" -C "$(dirname "${STAGE}")" "${NAME}"

echo "▶ Terminé"
find "${OUT_DIR}" -name "${NAME}.tar.gz" -printf '  %f  %s octets\n'
echo
echo "  Contenu :"
tar -tzf "${ARCHIVE}" | sed "s|^${NAME}/||" | grep -vE '^$|/$' | sort | sed 's/^/    /'
