# Implementation status

The obsolete custom Go realtime-gateway, its ECS Compose deployment, and its
test workflow have been removed. The approved standalone Centrifugo, Redis,
PostgreSQL, and Backend deployment is implemented for the `staging` cloud
environment through the immutable-digest workflow in
[Main to staging](main-to-staging.md#cloud-application); production stays
disabled behind the human approval gate. The release Skill must stop rather
than reconstruct or invoke the removed gateway workflow.

Production local publication is implemented by `release-production.yml` and
`release-installer-production.yml` (`environment: production`, RAM role
`coforge-release-publisher-production`, bucket `coforge-releases`, feed
`https://releases.coforge.cn`). Each rebuilds a commit staging already published;
see [the production release runbook](../operations/production/computer-release.md)
for the operator-provisioned bucket, CDN domain, and role they need.

The local feed topology in [Local Computer distribution model](local-distribution.md)
and the `releases.coforge.cn` consumer boundary in
[Feed hosting and installation entry points](local-feed-hosting.md) are approved.
`scripts/release/publish.ts`, run manually through
`.github/workflows/release-staging.yml` (`workflow_dispatch` only, `environment:
staging`), implements the [Main to staging](main-to-staging.md#local-computer-distribution)
local-distribution path: it runs the repository gates, cross-compiles the unified
Computer for a set of release targets, assembles the schema 2 version tree
(`build-release.ts`), uploads every object `buildReleaseTree` lists, and verifies
authenticated OSS read-back. Before updating `latest`, it verifies **every**
exact object key is byte-identical through authenticated OSS access and that an
unsigned exact-origin GET returns 403. Probe failures produce sanitized
diagnostics.
The existing `latest` bytes are saved and verified before activation. The new
selector is then checked through authenticated OSS read-back and the unsigned
origin guard; on failure the previous bytes are restored and verified, or a
first-publish selector is removed and absence checked.
Rollback verification failure is reported separately, never as a healthy release.
Object checks and the previous selector hash are retained in workflow logs.
The staging workflow reaches the Beijing release bucket through the global OSS
transfer acceleration endpoint `oss-accelerate.aliyuncs.com` (with
`--region oss-cn-beijing` for V4 signing), because the public path from
GitHub-hosted runners to `oss-cn-beijing` measured 17–56 KB/s from dev.59 on.
Acceleration must be enabled on the bucket; it is billed per GB as
overseas-to-mainland accelerated traffic (`AccO2MIn`).

The existing staging CDN policy revalidates `/latest` and `*.json` on each
request, while versioned binaries are immutable (see
`docs/operations/aliyun-oss-cdn/staging-record.md`, Section 10). Routine publication does not
request the CDN, change CDN configuration, or issue purge requests. Independent
infrastructure CDN acceptance tooling remains available to test the exact
consumer URL without cache-busting query parameters from an appropriate network;
its result describes domestic consumer-path reachability and cache behavior, not
the storage publication result. The user authorized this release-gate change on
2026-09-09; routine publications and their automatic rollback do not require a
new human approval merely because CDN read-back is omitted.

Explicitly authorized staging withdrawal is implemented by the same workflow's
`withdraw_version` mode and `scripts/release/withdraw.ts`: verify the pinned
previous release, restore `latest`, then delete the erroneous version's 14
objects with authenticated absence checks. See [Rollback](rollback.md#withdraw-a-mistakenly-published-staging-version).
This operation does not replace published versions or evict CDN caches.

Release notes are implemented by `scripts/release/release-notes.ts`: both
Computer publication workflows check the `notes_en`/`notes_zh_cn` inputs before
building and register them in the environment's Web release catalog after
`latest` moves by calling `release-notes.yml`, which also rewrites them later. The catalog's
publish tokens are the repository secrets `COFORGE_RELEASE_CATALOG_TOKEN_STAGING`
and `COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION`; see [Release notes](release-notes.md).

Platform coverage and remaining acceptance gaps are explicit:

- **Platform matrix**: `publish.ts --targets` defaults to all six targets:
  Linux, macOS, and Windows, each x64 and arm64. `release-staging.yml` uses
  this default and its reusable CI gates execute the existing compiled release
  identity/environment-binding tests on `windows-latest` and `windows-11-arm`.
  These are native executable smoke checks, not installer or upgrade tests. The
  publish jobs run on a macOS runner to sign the darwin executables (see
  *macOS code identity*).
- **Windows lifecycle acceptance**: clean bootstrap, installer upgrade and recovery,
  Supervisor and Workspace readiness, retained identity, and offline rollback still require
  end-to-end evidence before production promotion. External Agent process-tree
  supervision remains fail-closed.
- **macOS lifecycle runtime verification**: launchd unit generation and adapter
  behavior have automated coverage, but the complete install, installer upgrade,
  health-identity, and rollback flow has not yet run on a macOS host. Do not treat
  source-level tests as platform release evidence.
- **macOS code identity**: a publish with a darwin target signs those Computer
  executables with `codesign` on a macOS runner, using one long-lived
  self-signed certificate and the identifier `cn.coforge.computer`. Every
  version then has the same designated requirement, which macOS keys privacy
  (TCC) grants to; Bun's ad-hoc `cdhash` requirement changed per build. The
  certificate is committed under `scripts/release/darwin-signing/`, the key is
  the `COFORGE_DARWIN_SIGNING_KEY` Environment secret (keep an offline backup),
  and there is no hardened runtime or notarization yet. Mechanism and
  verification: the header of `scripts/release/darwin-signing.ts`.
- **macOS privacy grants and the executable path**: a probe run as its own
  launchd job on macOS 27.0.1 (2026-10-25) showed TCC also keys a grant to the
  executable's real path: with one self-signed certificate, a new version
  replaced in place at the granted path read `~/Documents` without a prompt,
  while the same bytes at a new path, or behind a symlink re-pointed to a new
  path, prompted again. A grant carried over an upgrade only when the new
  version replaced the executable at the same real path under the same
  certificate; `versions/<version>/` and the `active` symlink change that path
  with every version, so signing alone does not keep grants. Agents run in
  launchd jobs whose program is `coforge-computer __managed-agent`, so TCC
  attributes their privacy prompts to the Computer executable. Chosen direction
  for 0.1.11, pending approval of its design: run the executable from one fixed
  real path that the installer replaces atomically. Open: the installer's
  activation, rollback and repair on a fixed path.
- **Windows code identity**: the Windows executables are unsigned. Windows has
  no per-version privacy grants, but SmartScreen reputation and path-keyed
  firewall or Controlled Folder Access rules start over with each version.
  Authenticode signing is deferred; a fixed executable path is not yet decided
  for Windows.

Distribution credentials come from GitHub OIDC federation to the Alibaba Cloud
RAM role `coforge-release-publisher` (`ALIBABA_CLOUD_ROLE_ARN`/
`ALIBABA_CLOUD_OIDC_PROVIDER_ARN`, resolved through `@alicloud/credentials`'s
default chain with V4 request signing; see `docs/operations/staging/computer-release-trigger.md` and
`.github/workflows/release-staging.yml`) - no long-term AccessKey is stored for
this publisher. The bootstrap scripts (`install.sh`, `install.ps1`) and `coforge-installer` read
the same feed. The release Skill may publish development candidates through this
workflow, but must distinguish published targets and native smoke checks from
complete platform lifecycle acceptance. A successful live publish workflow
proves authenticated OSS storage read-back and private-origin rejection, not CDN
or end-user delivery. CDN acceptance remains a separate infrastructure check.
