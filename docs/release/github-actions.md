# Reading GitHub Actions

| Workflow                       | When it runs                        | Steps                                                                                    |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **CI**                         | A pull request is opened or updated, or a commit reaches `main` | Plan checks → validate affected packages and scripts → CI passed |
| **Deploy Web (staging)**       | Manually started from `main`        | Validate → build and push Docker image → deploy and verify Web                           |
| **Publish Computer (staging)** | Manually started from `main` with release notes | Check the notes and validate → build all six platforms → upload and verify release → update staging `latest` → register the notes |
| **Publish installer (staging)** | Manually started from `main`       | Validate → plan → build each target natively → package, upload, and verify, write the manifest, and update `installer/latest`; or with `pointer_only` move that pointer alone |
| **Publish installer (production)** | Manually started from `main` with an approved commit and version | Verify staging published it → approval → plan → build that commit natively against the production feed → package, upload, and verify, and update `installer/latest`; or with `pointer_only` move that pointer alone |
| **Publish Computer (production)** | Manually started from `main` with an approved commit, stable version, and release notes | Check the notes and verify the selected staging version's `latest` and manifest identify that commit and that the version follows the version rule below → approval → build that commit against the production feed → upload and verify → update production `latest` → register the notes |
| **Edit Computer release notes** | Manually started from `main` with an environment, a published version, and notes; also called by both Computer publications | Replace that version's notes in the environment's release catalog and verify the read-back |

Every staging workflow is manual. A Web deployment validates, builds, and
deploys the selected `main` commit whatever it changed. Computer publication's
run title includes the version. Its build, upload, integrity checks, and
selector update stay together in one publication transaction; expand that step
to see each platform and object.

Both Computer publications take the `notes_en` and `notes_zh_cn` inputs and
fail before building when either is missing, blank, or longer than 16000
characters; once `latest` has moved, a `notes` job calls `release-notes.yml`
to register them in that environment's release catalog. Staging's inputs are optional in the schema
only because a withdrawal needs none. See [Release notes](release-notes.md).

`Validate` reuses CI. Package jobs run tests, static checks, and a build where
applicable. The Web deployment omits the preliminary package build: Docker
builds and tests the runtime image once before publishing. Separate jobs check
macOS lifecycle, Windows executables, and the Windows installer. These checks can run in parallel. `CI passed` is the final
required check and keeps its existing name for branch protection.

CI has one reusable validation definition in `.github/workflows/ci.yml`, invoked
with three scopes selected by `scripts/ci/selection.ts`:

- Pull requests and pushes to `main` validate changed modules and affected
  downstream consumers.
  Web-only changes run Web gates; Daemon changes also validate Computer, and
  Web, whose tests and the benchmarks import Daemon source (the image has no
  Daemon, so a Daemon change never selects a Web deployment).
  Agent changes additionally validate Web's imported Agent test contract.
  Client source changes retain native macOS and Windows smoke checks. Changes
  confined to Computer/Daemon test files run their owning package; the three
  macOS lifecycle test files also run on macOS. Shared fixtures retain full
  consumer checks. Workspace manifests select their package's consumers plus
  Web's frozen image install; lockfile changes still select full coverage.
  PowerShell installer changes run both PowerShell parsers and lint. Both
  installers are embedded in the Web image, so changing either also validates Web.
  The benchmark packages import Web source, so the Web job also checks them
  (`bun run --filter './benchmark/*' check`) and a benchmark change runs the Web
  job; benchmarks are not in the image, so they never select a Web deployment.
- A dispatched Web deployment runs the complete Web track for its exact selected
  main commit: Web, protocol, CI-policy, and deploy-script gates, then builds and
  deploys the image.
- Manual local publication always runs the complete local track for its exact
  selected main commit: protocol, Agent, CLI, Computer, Daemon, release scripts,
  native macOS/Windows checks, and Windows installer checks. It does not run
  unrelated Web, deployment, or OSS/CDN acceptance-verifier checks.

Shared protocol, global toolchain/configuration, lockfile, CI, and unclassified
paths select full PR coverage. Only known documentation locations are exempt;
Markdown assets inside source directories remain code inputs. Documentation-only
PRs run path selection and changed-line whitespace checks without installing
workspace dependencies. CI-policy tests and workflow/static lint run as a
parallel script suite when shared inputs, CI, or unclassified files change.
No documentation link checker is currently configured.
PR diffs use the merge base. A push to `main` diffs from the head of CI's last
successful push run on `main`, so commits whose runs were superseded, cancelled,
or failed stay in scope until a run passes; with no earlier successful push run
it gets full coverage. Renames include both old and new paths. A dispatched run
has no diff base and gets its track's full coverage.

A push to `main`, a maintainer's direct push or a merged PR, is a post-push
safety net: CI validates it after it has landed and blocks nothing. It holds no
secret, environment, OIDC token, or write permission, and every deploy and
release workflow starts only by hand, so a push deploys and publishes nothing.
A red run on `main` means `main` is broken; fix it before pushing anything else.

Every run ends with `CI passed`, which requires successful selection and
every selected job to succeed. An unexpectedly skipped, failed, cancelled, or
missing selected job cannot pass. Configure branch protection to require this
aggregate rather than individual conditional/matrix job names; changing that
GitHub setting requires separate authorization. The `main` ruleset lets the
Maintain and Admin roles bypass it, and CI checks their direct pushes only
after they land, so a maintainer runs the local checks before pushing. A PR
update or a newer push to `main` cancels the stale CI run; release-track checks
do not cancel an active publication or deployment.
The cloud workflow keeps GitHub's default single pending run: a newer dispatch
replaces a waiting one, and the running deployment is never cancelled.

Module-owned test/check/build commands remain unchanged. Local full validation
still uses `mise run test`, `mise run check`, and `mise run build`; CI-policy
regressions can be exercised alone with `bun run test:ci` and `bun run check:ci`.
Track-specific pre-release validation is not replaced by a mutable "latest
successful CI" result. Docker image builds and version/feed-specific
cross-compilation remain artifact builds. Web deployment relies on its Docker
build instead of also building a disposable host bundle.

Package validation caches Bun's download cache by runner OS, architecture,
toolchain configuration, and lockfile. Every job still runs a frozen install;
cache hits never skip dependency validation. The image job installs only Bun on
the host; workspace dependencies are installed inside Docker. The image build
uses no build cache, since other jobs on `main` could write one and so supply
the image's layers. It sets `SOURCE_DATE_EPOCH` to `0` and exports with
`rewrite-timestamp=true` instead, so the files the build writes get that
constant timestamp. A layer rebuilt from unchanged inputs then keeps its digest
when its commands write the same bytes, as the migration toolchain's
`bun install` does, and deploy hosts do not pull it again.

Deploy and release jobs also restore nothing from the Actions cache:
`cache: false` on `jdx/mise-action` and `cache-binary: false` on
`docker/setup-buildx-action`. GitHub does not verify cache contents, and a
restored mise cache supplies the mise binary itself, which the action runs
unchecked in a job that holds deploy or publish credentials or builds what a
publish job uploads. CI jobs hold no deploy or publish credentials and publish
nothing, so they keep the cache.

The external realtime probe requires a successful WebSocket handshake within
ten seconds. HTTP error pages, including 404 and 502, fail deployment verification;
the probe does not claim to validate an authenticated application session.

Publishing a local-distribution release is **manual**. The workflow exposes only
`workflow_dispatch`; it is not triggered by merging to `main`. A client release
leaves a persistent artifact set behind, and at the current user count a build
per merge is waste.

Computer versions follow one rule, which the workflows enforce
(`scripts/release/release-line.ts`); there are only two routine forms, staging
dev builds such as `0.1.5-dev.3` and stable production versions such as `0.1.5`:

- **Line.** Staging publishes `<line>-dev.<N>`. The line is staging's own while
  staging's `latest` is above production's `latest`; otherwise it is
  production's `latest` with the patch incremented (`0.1.4` gives `0.1.5`).
  The `release-staging.yml` input `line` starts a new minor or major line such
  as `0.2.0`; it must be above production's `latest` and not below staging's line.
- **Staging number.** Each line counts its own dev builds by semver precedence
  (`dev.2 < dev.11`). With the version input empty, staging publishes the
  smallest `<line>-dev.<N>` above staging's `latest` (from 1 on a new line)
  whose `manifest.json` the feed does not have (`nextDevVersion` in
  `scripts/release/publish.ts`); a number whose publication failed before its
  manifest is reused, overwriting objects nothing referenced. An explicit
  version must be a dev build of the line and newer than staging's `latest`,
  and is refused once its manifest exists. These checks run before compiling.
- **Production.** `release-production.yml` promotes one staging build: its
  `version` is `staging_version` without the `-dev.<N>` suffix, newer than
  production's `latest`, from the same source commit; its candidate job checks
  this without credentials, before the approval gate.
- **Every feed.** Every publication through `scripts/release/publish.ts`,
  staging, production and installer alike, refuses a version older than that feed's
  `latest` (the same version is a finalize rerun): before uploading anything, or
  in a split publication before the activating pass moves `latest`.
  Only withdrawal and the installer's `pointer_only` move a pointer back.
- Production's `latest` is read anonymously from
  `https://releases.coforge.cn/latest`; if it cannot be read as a stable
  version, the staging publication or the promotion fails rather than guessing.

The `release-staging` concurrency group keeps two publications from choosing a
number at the same time. The source SHA and build time remain in the manifest
rather than the version string; there is no nightly schedule, date-based
version, beta or release-candidate stage. Previously published
versions, including historical `rc` versions, remain immutable and available
by exact version; the next successful publication moves `latest` without
renaming or deleting them. Explicitly authorized deletion of a mistaken staging
publication uses the separate [withdrawal mode](rollback.md#withdraw-a-mistakenly-published-staging-version),
which restores an existing complete version before deleting the selected one.

The production workflows take no `Validate` job: staging published that exact
commit only after its gates, and the `candidate` job requires that evidence.
How to run them is in
[the production release runbook](../operations/production/computer-release.md).

The installer has its own manual workflow and its own version, described in
[Installer feed and release workflow](installer-feed.md); the two publications
share the upload flow in `scripts/release/publish.ts`, and the Computer
publication checks that the installer it needs is published before it moves its
`latest`.

The Computer distribution is published to the release feed only. It is **not
published to npm**; that channel is purely additive and can be introduced later
without changing anything here.
