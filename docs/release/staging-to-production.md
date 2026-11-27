# Staging to production

## Cloud application

The release coordinator verifies the exact candidate, announces it in
`#release`, dispatches production from `main`, and verifies and reports the
result in the same thread. Follow the [routine release boundary](routine-release-boundary.md)
for exception approvals.

1. Select the actual latest commit on `main` when preparing the release.
   Record its full source commit, same-commit CI and Web integration results,
   and exact staging-healthy image digest. Also record the staging deployment,
   previous healthy production digest, change summary, risks, migration
   compatibility, and production configuration revision.
2. Dispatch the production workflow with that digest. The workflow verifies
   the exact digest is recorded healthy in staging and uses that record's source
   commit to identify the optional Artifact Checker image. The `production` GitHub
   Environment restricts the run to `main` and has no required reviewer.
3. Deploy the same digest with the production Compose project, using the
   bounded pulls documented in [Main to staging](main-to-staging.md#cloud-application).
4. Verify the running digest, public build, internal and public health and
   ingress, then record the result.

A different digest requires fresh evidence and a new announcement. Pin the
full `registry/repository@sha256:...` reference for each run.

### Reminder Due compatibility

- [ ] Deploy the ReminderDue Web migrations and server before publishing a
  Computer that advertises `reminder-due:v1`.
- [ ] Verify that upgraded Computers use server delivery and legacy Computers
  retain daemon timing; an overdue scheduled reminder is delivered once on upgrade.
- [ ] Before rolling Web back to a server without Due support, first downgrade
  every due-capable daemon. A daemon that stopped its timer cannot receive due
  reminders from an older Web server. Pending Due records expire with an alert
  on capability downgrade; they are never converted to legacy fires.

## Local Computer distribution

Computer and Installer promotion carries the exact source commit and its test
evidence. Production builds compile in the production feed and matching server.
The release coordinator follows the same announcement, dispatch and verification
sequence as for Web:

1. Verify same-commit CI and the published staging manifest's source commit,
   version and integrity. For Computer, confirm staging's `latest` names the
   selected numbered development build. Pin the stable production version using
   the [version rule](computer-versions.md) and read both languages of the
   [release notes](release-notes.md) from the staging catalog. For Installer,
   pin the published staging version and match it to the crate version at that
   source commit. Published version paths are immutable.
2. Record the evidence and announce the exact commit and versions in
   `#release`, then dispatch the matching production workflow from `main`.
3. Build that exact commit against the production feed configuration.
4. The workflow publishes the manifest, checksum sidecars and binaries under
   `<version>/` for Computer or `installer/<version>/` for Installer. It checks
   each object's stored length and CRC-64 through authenticated OSS `HEAD`
   and verifies each unsigned-origin 403 guard.
5. After those checks, the workflow advances `latest` for Computer or
   `installer/latest` for Installer to the verified version.
6. Read the pointer back through authenticated OSS, verify its exact bytes
   and unsigned-origin 403 guard, run the production local-distribution
   checks, and record the result.
7. For Computer, the workflow registers the production version's release notes
   in the production release catalog and verifies the read-back. Notes are text, not
   an artifact: they are checked before the build, and changing them
   later with `release-notes.yml` needs no new release decision.

`release-installer-production.yml` and `release-production.yml` implement
the respective staging comparison, build and publication gates.
`release-production.yml` also registers Computer release notes. The installer
goes first when a compatible production installer is needed, because
`install.sh` reads `installer/latest` from the same feed. See the
[production Computer and Installer runbook](../operations/production/computer-release.md).

Publication without staging and release with red or incomplete CI require
Frank's separate explicit approval. The `without_staging` path checks the commit and
version, verifies that a Computer version is newer than production's
`latest`, and checks the commit's CI verdict. Its existing
`allow_red_main` and `ci_override_reason` inputs record an approved CI
exception in the run summary. Record each applicable approval with its exact
scope before dispatch.

A source or version change requires fresh candidate verification. The
[production health checks](health-verification.md#local-computer-distribution)
verify the binaries actually published to the production feed.
