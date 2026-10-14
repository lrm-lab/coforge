# Installer feed and release workflow

`coforge-installer` is released on its own, separately from the Computer that
it installs. Its feed lives in the product's bucket under the `installer/`
prefix, its version is its crate's, and its release is one manual workflow.
What the installer does is in [`crates/installer/AGENTS.md`](../../crates/installer/AGENTS.md);
the Computer feed it installs from is in
[Local Computer distribution model](local-distribution.md).

## Feed layout

```text
installer/latest                                     plain text, one version string, e.g. "0.1.0"
installer/<iv>/manifest.json                         unsigned JSON, schema 1
installer/<iv>/<target>/coforge-installer.gz         gzip transport copy (coforge-installer.exe.gz on Windows)
installer/<iv>/<target>/coforge-installer.sha256     bare lowercase hex SHA-256 of the uncompressed binary, one line
installer/<iv>/THIRD_PARTY_NOTICES.txt               licence notices for the linked crates
```

`<target>` is one of the six release targets of the Computer feed. The
manifest is `InstallerManifestSchema` in
`packages/computer/src/release/installer-contract.ts` (golden
`crates/installer/contract/installer-manifest.v1.json`): `schema_version: 1`,
`version`, `commit`, `buildDate`, `installer_protocol`, and per target the
installer's `file`, `size`, `checksum`, and its `gzip` `file`, `size`,
`checksum`. `installer_protocol` is the protocol the installer implements
(`INSTALLER_PROTOCOL` in the same file).

- **Version.** `installer/<iv>/` is named by `version` in
  `crates/installer/Cargo.toml`, which is the only place the version is set; the
  workflow takes no version input. It moves independently of the Computer's
  release line.
- **Write once.** `installer/<iv>/manifest.json` is the completion marker and is
  written last. A version whose manifest exists is never published again: the
  workflow's plan step and its publishing job each refuse it.
  Raise `version` in `crates/installer/Cargo.toml` to release new bytes. Objects
  a failed run left beneath a version with no manifest are unreferenced and may be
  replaced by the next run.
- **`installer/latest`** is the only mutable object, the feed's pointer. It is
  written after everything it names, and only ever names a version whose manifest
  is up.
- **Private origin, integrity.** As for the Computer feed: the bucket refuses
  anonymous reads (the CDN serves it), every upload is read back byte for byte,
  and integrity is HTTPS plus SHA-256, with no signed envelope.
- **CDN freshness.** The pointer must never be served from cache. The staging CDN
  revalidates `/latest` and `*.json` on every request and caches everything else for
  a year. A directory-type rule matches by path prefix, so `/latest` does not cover
  `/installer/latest`; `installer/<iv>/manifest.json` is covered by the `json` suffix
  rule. The rule for `/installer/latest` is a prerequisite below.

## Consumers

`install.sh` and `install.ps1` read `installer/latest` for a first install. Each
`coforge-computer install`, `upgrade`, and server-triggered upgrade fetches it
fresh for every operation (`release/installer-launch.ts`), so a moved pointer
applies to the next operation without a Computer release. The installer then
installs Computer versions from the Computer feed described in
[Local Computer distribution model](local-distribution.md).

## Before the first installer release

Two pieces of infrastructure outside this repository have to exist. Neither is
applied or verified by this workflow.

- **CDN rule.** An always-revalidate rule for `/installer/latest` (directory type,
  TTL 0, Force Revalidation, weight 99, client `no-cache, must-revalidate`, the same
  as `/latest`). Without it a moved pointer, a `pointer_only` rollback included,
  stays invisible to Computers while an edge holds the old copy. The rule is
  tabulated in
  [`cdn-domains.md`](../operations/aliyun-oss-cdn/cdn-domains.md#53-url-signingcache-与-headers)
  and recorded as pending in
  [`staging-record.md`](../operations/aliyun-oss-cdn/staging-record.md). Verify it:

  ```sh
  curl -sI https://releases-staging.coforge.cn/installer/latest | grep -iE '^(HTTP|cache-control|age|x-cache)'
  ```

  Expect `Cache-Control: no-cache, must-revalidate` and no `Age` above 0 or `HIT`
  that outlives a pointer move. After the first release, move the pointer with
  `pointer_only` to another published version and check that `curl -s` of the same
  URL returns it at once.
- **RAM policy scope.** The RAM role `coforge-release-publisher` must be allowed
  `oss:GetObject` (which covers the existence probe), `oss:PutObject` and
  `oss:DeleteObject` on `acs:oss:*:*:coforge-releases-staging/installer/*`. The role's
  policy is not in this repository; one written for `<version>/*` and `latest` alone
  fails the workflow's first bucket call with `OSS probe failed: HTTP 403`.

## Publishing: `release-installer-staging.yml`

Manual (`workflow_dispatch`) and never on a push, like the Computer's. It
authenticates exactly as `release-staging.yml` does: GitHub OIDC exchanged for the
RAM role `coforge-release-publisher` through the `staging` environment, no stored
AccessKey. Every step is a subcommand of `scripts/release/publish-installer.ts`,
which goes through `scripts/release/publish.ts`'s upload flow - the flow the
Computer release uses (objects up and read back, the manifest last, the pointer
saved, written, read back, and restored on failure); there is no second upload path.

```sh
gh workflow run release-installer-staging.yml --repo lrm-lab/coforge
gh workflow run release-installer-staging.yml --repo lrm-lab/coforge -f pointer_only=0.1.0
```

| Job           | What it does                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gates`       | `ci.yml` with the `installer` track: the `installer-crate` check (format, clippy, tests, contract output, deny, audit, notices) on the six native runners, for the exact `main` commit                                                        |
| `plan`        | Refuses a version whose manifest already exists, before any runner builds                                                                                                                                                                     |
| `build` (six) | Builds one target on its native runner (`installer-crate`'s matrix) with `COFORGE_RELEASE_FEED_URL` set to the staging feed; signs and verifies the darwin binaries; hands the binary on as an artifact. Holds no credential and no environment |
| `publish`     | Packages the six binaries, uploads every object and reads it back, writes the manifest, then moves `installer/latest`. Compiles nothing                                                                                                       |
| `pointer`     | Only for `pointer_only`: moves `installer/latest` alone                                                                                                                                                                                       |

- **No credential beside a compiler.** `cargo build` runs the build scripts and
  proc-macros of about sixty crates, so the `build` jobs hold `contents: read` only
  and no OIDC token. Only `plan`, `publish` and `pointer` hold one, and none of them
  compiles anything (`scripts/ci/workflow.test.ts` fails a build job that gains
  `id-token`).
- **Artifacts stay apart.** The publisher downloads each build's artifact into a
  directory of its own, never merged, so one build cannot replace another target's
  binary. From `installer-<target>/` it takes only that target's file name (the
  notices only from `installer-linux-x64/`) and refuses any other file, a
  directory, or a link.
- **The binary is checked against its target** before it is packaged, from its
  header bytes alone (nothing is executed): a 64-bit Mach-O for arm64 or x86_64 on
  darwin, a 64-bit little-endian ELF for aarch64 or x86_64 on linux, a PE32+ image
  for ARM64 or AMD64 on windows. A binary of another format or CPU fails
  `publish` before the bucket is asked anything.
- `linux-x64` also generates `THIRD_PARTY_NOTICES.txt` and hands it on beside its
  binary. `publish` refuses a version without it, and without any of the six
  targets, before it asks the bucket anything.
- The manifest's identities are computed from the packaged bytes: the gzip's size and
  checksum, and the size and checksum of what it expands to (bounded). A sidecar
  that does not hold that checksum is refused, because the bootstrap scripts
  read only the sidecar.
- **`pointer_only: <iv>`** skips the build and publication. It moves
  `installer/latest` to `<iv>`, forward or back, and writes nothing else. It
  refuses a version with no manifest, or one that is not a complete installer
  manifest for that version. This is how a bad installer is rolled back: the
  Computers fetch `installer/latest` fresh for each operation, so no Computer
  release is needed.
- **Re-running.** Re-running the failed jobs of a run is safe: `publish` packages
  the same artifacts again and replaces objects a failed attempt left beneath a
  version with no manifest, which nothing references. A run that completed cannot be
  re-run, because `plan` refuses its version. If `publish` wrote the manifest but
  could not move the pointer (the previous pointer is restored and verified), the
  version is complete; move the pointer with `pointer_only`.
- **Concurrency.** Runs share the group `release-installer-staging` and none is
  cancelled while it runs, but GitHub keeps one running run and one pending run: a
  newer dispatch replaces an older pending one, which then shows as cancelled. A
  queued rollback can be lost that way. Dispatch one run at a time: check
  `gh run list --workflow release-installer-staging.yml --repo lrm-lab/coforge`
  first, and after a dispatch that queued behind a running run, look again. If a
  pending `pointer_only` run was replaced, dispatch it again once the running run
  finishes, and confirm the pointer with the job summary or
  `curl -s https://releases-staging.coforge.cn/installer/latest`.
- A production installer follows the Computer's rule: the approved commit is
  built again against the production feed, never copied
  ([Staging to production](staging-to-production.md)).
  `release-installer-production.yml` is this workflow with a `candidate` job in
  place of `gates` (staging must have published that version from that commit),
  the production role and bucket `coforge-releases`, and the group
  `release-installer-production`.

## Product gate

A Computer release may declare `installer_protocol` in its schema 2 manifest: the
lowest installer protocol that can install it. Before the Computer publication
moves its own `latest`, `scripts/release/publish.ts` checks that
`installer/latest` names an installer whose `installer_protocol` is at least
that. The check runs after the release tree is built and before any object is
uploaded, so a refusal leaves no half-published version, and the same version is
publishable again once an installer that speaks the protocol is up. It runs only
in a publication that moves `latest`.

- A release whose manifest has no `installer_protocol` needs no installer, and the
  installer feed is not read. `scripts/release/build-release.ts` does not write the
  field yet: the Computer release that first depends on the installer writes it,
  from `INSTALLER_PROTOCOL`.
- A release that needs an installer is refused while `installer/latest` is absent,
  names something that is not a version, or names a version whose manifest is
  missing or invalid, and while the installer speaks a lower protocol.
- The message names the two ways out: publish an installer that speaks it (raise
  the crate's `version` and run the workflow), or, when one is already
  published, point at it with `pointer_only`.
- A field that is present but not a positive integer fails the publication; it is
  never read as absent.
- `pointer_only` does not check the reverse: it can move `installer/latest` below
  a protocol a published Computer release needs. Rolling back a bad installer must
  not be blocked, so the operator owns that.
