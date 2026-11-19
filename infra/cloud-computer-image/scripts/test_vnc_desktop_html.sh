#!/usr/bin/env bash
# The baked desktop page must be real browser JS, not TypeScript string escapes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
html="${ROOT}/scripts/vnc-desktop.html"
grep -q 'import RFB from "./core/rfb.js"' "$html"
grep -qF '`?token=${encodeURIComponent(token)}`' "$html"
grep -qF '`${proto}://${location.host}${base}/websockify${query}`' "$html"
if grep -F '\`' "$html" >/dev/null || grep -F '\${' "$html" >/dev/null; then
  echo "FAIL: vnc-desktop.html still contains TypeScript template escapes" >&2
  exit 1
fi
echo "ok"
