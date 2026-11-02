#!/usr/bin/env bash
# Check a release-built coforge-installer on the runner that built it (CI's installer-crate job):
# sign and verify a darwin binary, report its size, and run it.
# Usage: check-installer-binary.sh <release-target> <binary>
set -euo pipefail
target="$1"
binary="$2"

# Apple's linker ad-hoc signs arm64 output but leaves x86_64 output unsigned, so darwin-x64 is
# ad-hoc signed the way Bun signs its darwin-x64 executables. macOS 27 kills a binary whose
# signature is invalid, which `codesign --verify --strict` catches.
if [ "$target" = darwin-x64 ]; then
  codesign --sign - --force "$binary"
fi
if [[ "$target" == darwin-* ]]; then
  codesign -dv --verbose=2 "$binary"
  codesign --verify --strict --verbose=2 "$binary"
fi

size="$(wc -c <"$binary" | tr -d ' ')"
echo "$target: $size bytes"
echo "coforge-installer $target: $size bytes" >>"$GITHUB_STEP_SUMMARY"
file "$binary" || true
# The Linux binaries are statically linked against musl.
if [[ "$target" == linux-* ]]; then
  ldd "$binary" || true
fi

# darwin-x64 is cross-compiled on the arm64 runner; every other target is built natively.
if [ "$target" != darwin-x64 ]; then
  "$binary" --version
elif arch -x86_64 /usr/bin/true 2>/dev/null; then
  arch -x86_64 "$binary" --version
else
  echo "::warning::Rosetta is not installed on this runner; darwin-x64 was built but not run"
fi
