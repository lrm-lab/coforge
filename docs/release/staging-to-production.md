# Staging to production

## Cloud application

Cloud production promotion is a two-party operation:

1. An Agent prepares a promotion request containing the exact digest, source
   commit, staging deployment run, staging health result, change summary, known
   risks, migration compatibility, production configuration revision, and
   previous healthy production digest.
2. A human reviews the request and approves or rejects that exact digest.
   Approval is the human's dispatch of the production workflow; the
   `production` GitHub Environment restricts the run to `main` but has no
   required reviewer. The Agent that prepared or triggered the promotion
   cannot substitute for the human's review.
3. The dispatched run verifies that its digest input matches the approved
   digest and that the same digest is still recorded healthy in `staging`.
4. The workflow deploys the digest with the production Compose project. It
   does not rebuild the image, and it pulls it with the same bounded attempts
   as staging ([Main to staging](main-to-staging.md#cloud-application), step 5).
5. The Agent monitors internal and external health, records the result, and
   reports the final production digest.

Changing the digest invalidates the approval. A failed or cancelled attempt
does not authorize a different candidate. An approval of `latest`, a branch,
an unspecified future release, or a commit without its full `sha256:...` digest
is invalid.

## Local Computer distribution

The local Computer distribution uses the same two-party boundary, but what
crosses it is the **source commit and its evidence, not the artifact**. Staging
and production binaries cannot be the same bytes: the feed a build trusts is
compiled into it, so a staging binary copied into the production feed would keep
updating itself from staging. Promotion therefore rebuilds:

1. An Agent verifies the staging feed's `latest` resolves the explicitly selected
   development candidate, such as `0.1.5-dev.3`. It prepares that candidate's
   source commit, staging version and test evidence, and the production version,
   which is the staging version without its `-dev.<N>` suffix (`0.1.5`), as
   the [version rule](github-actions.md) that `release-production.yml` checks
   requires. Do not overwrite an existing immutable
   version to align the channel labels, or use `without_staging` to bypass this
   comparison. The Agent also reads that candidate's
   [release notes](release-notes.md) from the staging catalog and passes the same
   English and Chinese text to production.
2. A human reviews the evidence and approves or rejects that exact commit and
   production version; approval is the human's dispatch of the production
   workflow with those inputs. A filename, branch, channel name, or
   unspecified "latest build" approval is invalid.
3. The dispatched run builds the approved commit against the production
   feed configuration, producing a distinct set of binaries whose intended
   differences from the staging set are the approved release version and the
   compiled-in environment (feed and matching business server addresses).
4. The Agent publishes the new manifest, checksum sidecars and binaries beneath
   the production feed's `<version>/` path, then performs authenticated OSS
   byte-identical read-back and verifies the unsigned-origin 403 guard for each
   object.
5. Only after that confirmation does the Agent write the production feed's
   `latest` pointer to the approved version.
6. The Agent re-reads the production feed's `latest` through authenticated OSS
   access, verifies its exact bytes and unsigned-origin 403 guard, runs the
   production local-distribution checks, and records the result.
7. The workflow registers the release notes for the production version in the
   production release catalog and verifies the read-back. Notes are text, not
   an artifact: they are checked before the build, and changing them
   later with `release-notes.yml` needs no new release decision.

`release-installer-production.yml` and `release-production.yml` implement
steps 1 and 3-6 for the installer and the Computer, and `release-production.yml`
also step 7; step 2 is the operator's manual dispatch, which the `production`
GitHub Environment restricts to `main` (it has no required reviewer). The
installer goes first, because `install.sh` reads `installer/latest` from the
same feed. The runbook is
[`operations/production/computer-release.md`](../operations/production/computer-release.md).

Their `without_staging` input skips the staging comparison and checks only the
commit's and version's shape, and that a Computer version is newer than
production's `latest`. It exists for a release Frank runs without a
staging publication (the first production release, `0.1.0` from `main`, on
2026-10-12); the run title names it, so the operator sees it.

Building a commit other than the approved one, or altering the source between
approval and build, invalidates the approval. Because the artifacts are rebuilt
rather than copied, the production checks in
[Health verification](health-verification.md#local-computer-distribution) are the evidence
that the production binaries work — the staging evidence attests to the commit,
not to those bytes.
