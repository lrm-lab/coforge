# Studying the reference Computer

Read this before researching how the reference Computer works. The comparison
reference is always the **latest shipped release**: resolve it at the start of
the research (see [Recovering the binary](recovering-the-binary.md)) instead of
reusing a version from an earlier note. Do not substitute an npm package.

The npm registry still hosts `@botiverse/raft-computer` (last 0.0.70) and
`@botiverse/raft-daemon` (1.0.17). Those are older, differently packaged
builds. Their command surface, lifecycle code, and contracts are not evidence
for the current product. Use them only to confirm that the source is esbuild
output with paths preserved.

The reference Computer is the closest shipped analogue to `coforge-computer`:
one native executable that hosts the human-facing control-plane CLI, the
resident daemon, and the agent-facing `raft` CLI, and registers itself with
launchd/systemd on `start`. Installing and upgrading it is the job of a
separate native installer. The GitHub repository (`botiverse/slock`) is
private, so the source is recovered from the shipped binary.

## Topics

- [Recovering the binary and its source](recovering-the-binary.md): how to
  resolve the latest release from the official metadata, verify its hash, cut
  the JS bundle out of the single-executable file, and split it by path.
- [What the extracted tree contains](source-tree.md): the package layout, the
  agent-facing `raft` command tree, the human-facing `raft-computer` commands,
  and where to start reading.
- [The separate installer](installer.md): how upgrades launch a native
  installer fetched at upgrade time, and what to verify about it.

Compare with [`docs/release/`](../../release/README.md).

## Boundaries

- The repository is private and carries no license. Read for design
  comparison only. Do not copy code, identifiers, or prose into CoForge.
- Record conclusions in your own words and cite the path in the extracted
  tree, or the command name inside the daemon bundle, so a reviewer can
  re-derive them.
- Record the version you actually examined, with its artifact target, release
  id, hash, and observation date, in each research note, CR, or code comment
  that cites the reference. A conclusion holds for that version; when a later
  release is out, re-check it there rather than carrying it forward unverified.
- Never mix evidence from different releases, an npm package, or an
  unverified artifact into one conclusion.
