#!/usr/bin/env bash
# Bake Lenovo ModelFactory into Pi agent config (image build or runtime):
#   provider = modelfactoryllm (default model DeepSeek; other ModelFactory
#   models come from pi-modelfactory-provider.json for user selection)
# Requires LENOVO_DEEPSEEK_V4_FLASH_API_KEY.
set -euo pipefail

log() { echo "[bake-pi-deepseek] $*"; }

PI_HOME="${PI_HOME:-/root}"
AGENT_DIR="${PI_AGENT_DIR:-${PI_HOME}/.pi/agent}"
MODELS_FILE="${AGENT_DIR}/models.json"
SETTINGS_FILE="${AGENT_DIR}/settings.json"
CERTS_DIR="${AGENT_DIR}/certs"
CA_CERT_FILE="${LENOVO_MODELFACTORY_CA_CERT:-${CERTS_DIR}/lenovo-modelfactory-ca.pem}"
MODEL_FACTORY_ENV_FILE="${LENOVO_MODEL_FACTORY_ENV_FILE:-${AGENT_DIR}/model-factory.env}"

LENOVO_DEEPSEEK_PROVIDER="${LENOVO_DEEPSEEK_PROVIDER:-modelfactoryllm}"
LENOVO_DEEPSEEK_MODEL="${LENOVO_DEEPSEEK_MODEL:-DeepSeek}"
LENOVO_DEEPSEEK_BASE_URL="${LENOVO_DEEPSEEK_BASE_URL:-https://modelfactory.lenovo.com/llm/v1}"
LENOVO_DEEPSEEK_MODEL_NAME="${LENOVO_DEEPSEEK_MODEL_NAME:-DeepSeek}"
LENOVO_DEEPSEEK_AS_DEFAULT="${LENOVO_DEEPSEEK_AS_DEFAULT:-1}"
PI_MODELFACTORY_TEMPLATE="${PI_MODELFACTORY_TEMPLATE:-/usr/local/share/coforge/pi-modelfactory-provider.json}"
LENOVO_MODELFACTORY_HOST="${LENOVO_MODELFACTORY_HOST:-modelfactory.lenovo.com}"
LENOVO_MODELFACTORY_IP="${LENOVO_MODELFACTORY_IP:-10.110.158.101}"
DEEPSEEK_API_KEY="${LENOVO_DEEPSEEK_V4_FLASH_API_KEY:-}"

if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
  log "ERROR: LENOVO_DEEPSEEK_V4_FLASH_API_KEY is required" >&2
  exit 1
fi

mkdir -p "${AGENT_DIR}" "${CERTS_DIR}"

APPEND_SYSTEM_TEMPLATE="${PI_APPEND_SYSTEM_TEMPLATE:-/usr/local/share/coforge/pi-APPEND_SYSTEM.md}"
if [[ -f "${APPEND_SYSTEM_TEMPLATE}" ]]; then
  cp "${APPEND_SYSTEM_TEMPLATE}" "${AGENT_DIR}/APPEND_SYSTEM.md"
  chmod 644 "${AGENT_DIR}/APPEND_SYSTEM.md" || true
  log "installed APPEND_SYSTEM.md from ${APPEND_SYSTEM_TEMPLATE}"
elif [[ ! -f "${AGENT_DIR}/APPEND_SYSTEM.md" ]]; then
  log "WARN: APPEND_SYSTEM template missing at ${APPEND_SYSTEM_TEMPLATE}"
fi

SKILLS_TEMPLATE="${PI_SKILLS_TEMPLATE:-/usr/local/share/coforge/pi-skills}"
SKILLS_DIR="${AGENT_DIR}/skills"
# Build-time seed only. Runtime persistence is sync-pi-skills.sh (/workspace/skills).
if [[ -d "${SKILLS_TEMPLATE}" ]]; then
  mkdir -p "${SKILLS_DIR}"
  for skill_name in cloud-computer-overview browser-login lenovo-intranet; do
    if [[ -d "${SKILLS_TEMPLATE}/${skill_name}" ]]; then
      rm -rf "${SKILLS_DIR}/${skill_name}"
      cp -a "${SKILLS_TEMPLATE}/${skill_name}" "${SKILLS_DIR}/${skill_name}"
    fi
  done
  log "installed Pi skills from ${SKILLS_TEMPLATE}"
elif [[ ! -d "${SKILLS_DIR}/cloud-computer-overview" ]]; then
  log "WARN: Pi skills template missing at ${SKILLS_TEMPLATE}"
fi

if [[ ! -f "${CA_CERT_FILE}" && -f /root/.pi/agent/certs/lenovo-modelfactory-ca.pem ]]; then
  cp /root/.pi/agent/certs/lenovo-modelfactory-ca.pem "${CA_CERT_FILE}"
fi
if [[ -f "${CA_CERT_FILE}" ]]; then
  chmod 644 "${CA_CERT_FILE}" || true
fi

umask 077
cat > "${MODEL_FACTORY_ENV_FILE}" <<EOF
LENOVO_DEEPSEEK_V4_FLASH_API_KEY=${DEEPSEEK_API_KEY}
EOF
chmod 600 "${MODEL_FACTORY_ENV_FILE}"

export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-${CA_CERT_FILE}}"

pin_hosts() {
  local host="$1"
  local ip="$2"
  [[ -n "${host}" && -n "${ip}" && -w /etc/hosts ]] || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v h="${host}" -v ip="${ip}" '
    $0 ~ /^[[:space:]]*#/ { print; next }
    {
      found=0
      for (i=2; i<=NF; i++) if ($i == h) found=1
      if (found) next
      print
    }
    END { print ip " " h }
  ' /etc/hosts > "${tmp}"
  cat "${tmp}" > /etc/hosts
  rm -f "${tmp}"
  log "dns ${host} -> ${ip}"
}

pin_hosts "${LENOVO_MODELFACTORY_HOST}" "${LENOVO_MODELFACTORY_IP}"

PI_MODELS_FILE="${MODELS_FILE}" \
PI_SETTINGS_FILE="${SETTINGS_FILE}" \
PI_MODELFACTORY_TEMPLATE="${PI_MODELFACTORY_TEMPLATE}" \
LENOVO_DEEPSEEK_PROVIDER="${LENOVO_DEEPSEEK_PROVIDER}" \
LENOVO_DEEPSEEK_MODEL="${LENOVO_DEEPSEEK_MODEL}" \
LENOVO_DEEPSEEK_BASE_URL="${LENOVO_DEEPSEEK_BASE_URL}" \
LENOVO_DEEPSEEK_MODEL_NAME="${LENOVO_DEEPSEEK_MODEL_NAME}" \
LENOVO_DEEPSEEK_AS_DEFAULT="${LENOVO_DEEPSEEK_AS_DEFAULT}" \
LENOVO_DEEPSEEK_V4_FLASH_API_KEY="${DEEPSEEK_API_KEY}" \
node <<'NODE'
const fs = require("node:fs");

function readJson(path) {
  try {
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

function providerFromTemplate(templatePath, fallbackCompat, fallbackModels, baseUrl, apiKey) {
  const template = templatePath && fs.existsSync(templatePath) ? readJson(templatePath) : {};
  return {
    baseUrl: String(baseUrl || template.baseUrl || "").trim(),
    api: template.api || "openai-completions",
    apiKey,
    compat: template.compat || fallbackCompat,
    models: Array.isArray(template.models) && template.models.length > 0 ? template.models : fallbackModels,
  };
}

const modelsPath = process.env.PI_MODELS_FILE;
const settingsPath = process.env.PI_SETTINGS_FILE;

const providerName = String(process.env.LENOVO_DEEPSEEK_PROVIDER || "modelfactoryllm").trim() || "modelfactoryllm";
const defaultModelId = String(process.env.LENOVO_DEEPSEEK_MODEL || "DeepSeek").trim() || "DeepSeek";
const apiKey = String(process.env.LENOVO_DEEPSEEK_V4_FLASH_API_KEY || "").trim();
const asDefault = String(process.env.LENOVO_DEEPSEEK_AS_DEFAULT || "1").trim() !== "0";

const models = readJson(modelsPath);
const providers = models.providers && typeof models.providers === "object" ? { ...models.providers } : {};

// Drop legacy Aimaster provider names if present.
delete providers.llm1;
delete providers.llm2;

providers[providerName] = providerFromTemplate(
  String(process.env.PI_MODELFACTORY_TEMPLATE || "").trim(),
  {
    supportsDeveloperRole: false,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } },
  },
  [{
    id: defaultModelId,
    name: String(process.env.LENOVO_DEEPSEEK_MODEL_NAME || "DeepSeek").trim(),
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 8192,
  }],
  process.env.LENOVO_DEEPSEEK_BASE_URL,
  apiKey,
);

const next = { ...models, providers };
fs.writeFileSync(modelsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
try { fs.chmodSync(modelsPath, 0o600); } catch {}

const defaultProvider = asDefault ? providerName : (readJson(settingsPath).defaultProvider || providerName);
const defaultModel = asDefault ? defaultModelId : (readJson(settingsPath).defaultModel || defaultModelId);

const settings = readJson(settingsPath);
const packages = Array.isArray(settings.packages) ? settings.packages : undefined;
fs.writeFileSync(settingsPath, `${JSON.stringify({
  ...settings,
  ...(packages ? { packages } : {}),
  defaultProvider,
  defaultModel,
  defaultThinkingLevel: settings.defaultThinkingLevel ?? "high",
  theme: settings.theme ?? "dark",
}, null, 2)}\n`, { mode: 0o600 });
try { fs.chmodSync(settingsPath, 0o600); } catch {}

console.log(`[bake-pi-deepseek] providers=${Object.keys(providers).join(",")} defaultProvider=${defaultProvider} defaultModel=${defaultModel}`);
NODE

if [[ -d /etc/profile.d && -w /etc/profile.d ]]; then
  printf '%s\n' \
    "export NODE_EXTRA_CA_CERTS=\"\${NODE_EXTRA_CA_CERTS:-${CA_CERT_FILE}}\"" \
    > /etc/profile.d/lenovo-modelfactory-ca.sh \
    || log "WARN: could not write /etc/profile.d/lenovo-modelfactory-ca.sh"
  chmod 644 /etc/profile.d/lenovo-modelfactory-ca.sh 2>/dev/null || true
fi

log "baked ${LENOVO_DEEPSEEK_PROVIDER}(DeepSeek+) into ${MODELS_FILE} and ${SETTINGS_FILE}"
