# The separate installer

Upgrade, and first install, run a native installer that is not necessarily
inside the Computer binary. The 1.0.45 Computer source uses its installer
integration to fetch, verify, cache, and launch that executable. Treat the
installer release as a separate artifact: its channel and release id can drift
independently of the Computer version.

## Locating and verifying it

- Resolve the installer from the official Hands release authority for the
  target and platform. Follow the release redirect, fetch its checksum list or
  metadata, and verify the selected `native/<target>/raft-computer-installer`
  file before inspecting it.
- Record the installer release id, target, size, SHA256, and observation date
  in the 1.0.45 research note. Do not carry forward a release id or hash from
  an older note, and do not treat the Computer's 1.0.45 hash as the installer
  hash.
- The installer is a native executable with no recoverable TypeScript source.
  Use `strings` and the Computer's caller only as behavioral evidence, and mark
  undocumented protocol tags or flags as unverified until the 1.0.45 artifact
  is checked.

## How the Computer drives it

- Inspect the recovered 1.0.45 `externalInstaller.ts` and its callers to map
  target-version, channel, downgrade, and confirmation arguments. Record the
  exact argument vector and the source path that builds it.
- The CLI and resident service may launch the installer through different
  lifecycle paths. Trace both the attached CLI path and the detached service
  path before claiming that an upgrade behavior is shared.
- Inspect the receipt path and outcome mapping in the 1.0.45 tree. A receipt
  consumed by the resident lifecycle bridge is evidence of installer
  coordination, not proof that the upgrade succeeded; verify the promoted
  version separately.

The installer binary and its checksum files belong in session scratch space,
never in this repository. Compare release behavior with
[`docs/release/`](../../release/README.md) where relevant.
