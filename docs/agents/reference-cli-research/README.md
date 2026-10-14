# Studying the reference Computer 1.0.45

Read this before researching how the reference Computer works. The comparison
reference is the shipped binary **1.0.45**. Pin that version when recovering an
artifact; do not silently substitute an npm package or another release.

The npm registry still hosts `@botiverse/raft-computer` (last 0.0.70) and
`@botiverse/raft-daemon` (1.0.17). Those are older, differently packaged
builds. Their command surface, lifecycle code, and contracts are not evidence
for the 1.0.45 product. Use them only to confirm that the source is esbuild
output with paths preserved.

The reference Computer is the closest shipped analogue to `coforge-computer`:
one native executable that hosts the human-facing control-plane CLI, the
resident daemon, and the agent-facing `raft` CLI, and registers itself with
launchd/systemd on `start`. Installing and upgrading it is the job of a
separate native installer. The GitHub repository (`botiverse/slock`) is
private, so the source is recovered from the 1.0.45 binary.

## Topics

- [Recovering the binary and its source](recovering-the-binary.md): where the
  official 1.0.45 metadata and hashes come from, and how to cut the JS bundle
  out of the single-executable file and split it by path.
- [What the extracted tree contains](source-tree.md): the 1.0.45 package
  layout, the agent-facing `raft` command tree, the human-facing
  `raft-computer` commands, and where to start reading.
- [The separate installer](installer.md): how upgrades launch a native
  installer fetched at upgrade time, and what must be re-verified for 1.0.45.

Compare with [`docs/release/`](../../release/README.md).

## Boundaries

- The repository is private and carries no license. Read for design
  comparison only. Do not copy code, identifiers, or prose into CoForge.
- Record conclusions in your own words and cite the path in the extracted
  **1.0.45** tree, or the command name inside the daemon bundle, so a reviewer
  can re-derive them.
- Record the exact artifact target, release metadata, hash, and observation
  date in each research note. Never mix evidence from an older release, an npm
  package, or an unverified artifact into a 1.0.45 conclusion.
