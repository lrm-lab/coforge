#!/usr/bin/env bash
# Validate and build the Rust installer crate for one target in CI's installer-crate job.
# Expects RELEASE_TARGET, RUST_TARGET, NATIVE, and BINARY in the environment and runs in crates/installer.
set -euo pipefail

run_group() {
  local title="$1"
  shift
  local status=0
  echo "::group::$title"
  "$@" || status=$?
  echo "::endgroup::"
  return "$status"
}

if [ "$RELEASE_TARGET" = linux-x64 ]; then
  run_group "Check formatting" mise exec rust -- cargo fmt --check
fi

# Per target: cfg(unix) and cfg(windows) code differs.
run_group "Lint" mise exec rust -- cargo clippy --locked --all-targets --target "$RUST_TARGET" -- -D warnings

if [ "$NATIVE" = true ]; then
  # Bun runs the Computer's own machine mutation lock (packages/daemon) against the
  # installer's in src/lock/tests.rs, so the two are proven to exclude each other.
  run_group "Test" mise exec rust bun -- cargo test --locked --target "$RUST_TARGET"

  # The tests write what the installer produces into contract/rust/, which the Computer
  # package's tests read back; the committed copy must match on every native target.
  run_group "Check the contract output is committed" bash ../../scripts/ci/require-committed.sh contract
fi

run_group "Build release binary" mise exec rust -- cargo build --locked --release --target "$RUST_TARGET"
run_group "Sign, verify, and run the release binary" bash ../../scripts/ci/check-installer-binary.sh "$RELEASE_TARGET" "$BINARY"

if [ "$RELEASE_TARGET" = linux-x64 ]; then
  run_group "Check dependency licenses, bans, and sources" mise exec -- cargo deny --locked check licenses bans sources
  run_group "Generate third-party notices" mise exec -- cargo about generate --locked --fail --output-file THIRD_PARTY_NOTICES.txt about/notices.hbs
fi
