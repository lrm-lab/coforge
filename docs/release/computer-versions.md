# Computer versions

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
