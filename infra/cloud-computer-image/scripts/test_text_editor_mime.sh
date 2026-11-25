#!/usr/bin/env bash
# Double-clicking text files must resolve to a handler whose Exec binary exists
# in the slim desktop image (nano), not broken vim.desktop (Exec=vim).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
desktop="${ROOT}/config/xfce/applications/coforge-text-editor.desktop"
mimeapps="${ROOT}/config/xfce/mimeapps.list"

test -f "$desktop"
test -f "$mimeapps"
grep -q '^Type=Application$' "$desktop"
grep -q '^TryExec=nano$' "$desktop"
grep -q '^Exec=xfce4-terminal --disable-server -e nano %f$' "$desktop"
grep -q 'MimeType=.*text/plain' "$desktop"
grep -q '^text/plain=coforge-text-editor.desktop$' "$mimeapps"
grep -q '^\[Default Applications\]$' "$mimeapps"
echo "ok"
