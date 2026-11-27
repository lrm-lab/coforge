#!/usr/bin/env bash
set -euo pipefail

real_codex=${COFORGE_CODEX_E2E_REAL_CODEX:?The isolated Codex executable is required}
probe_dir=${COFORGE_CODEX_E2E_PROBE_DIR:?The private probe directory is required}

if [[ " $* " == *' model_provider="coforge-openai-compatible" '* ]]; then
  standard_key_absent=false
  standard_url_absent=false
  provider_key_matched=false
  [[ -v OPENAI_API_KEY ]] || standard_key_absent=true
  [[ -v OPENAI_BASE_URL ]] || standard_url_absent=true
  if [[ -v COFORGE_CODEX_COMPATIBLE_API_KEY ]] && [[ -s "$probe_dir/expected.sha256" ]]; then
    digest=$(printf '%s' "$COFORGE_CODEX_COMPATIBLE_API_KEY" | sha256sum)
    [[ "${digest%% *}" != "$(<"$probe_dir/expected.sha256")" ]] || provider_key_matched=true
  fi
  printf '{"standardKeyAbsent":%s,"standardUrlAbsent":%s,"providerKeyMatched":%s}\n' \
    "$standard_key_absent" "$standard_url_absent" "$provider_key_matched" >> "$probe_dir/launch.jsonl"
fi

exec "$real_codex" "$@"
