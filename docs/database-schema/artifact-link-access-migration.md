# Link access migration

`apps/web/scripts/artifact-link-access-migration.ts` moves every artifact a person had
already shared by public link onto the `link` visibility tier, and can put them back. It
runs by hand, never at startup, and changes only `artifacts.access` and
`artifact_access_events`; the schema is untouched.

An artifact is a candidate when it is not deleted, its tier is `conversation` or
`workspace`, and it has a live (unrevoked) public link. An artifact with only revoked
links, or already on `link`, is left alone.

## Commands

Run from `apps/web` with the repository's pinned Bun, with `DATABASE_URL` in the
environment, never in arguments.

| Command | Result |
| --- | --- |
| `bun scripts/artifact-link-access-migration.ts dry-run` | Counts by current tier and how many are already `link`; writes nothing |
| `bun scripts/artifact-link-access-migration.ts apply --journal <new-file>` | Migrates every candidate and appends one journal record per artifact |
| `bun scripts/artifact-link-access-migration.ts rollback --journal <file>` | Restores the tiers this journal's own changes set; skips anything changed since |

`apply` requires a path that does not exist yet: the journal is the only record that
makes rollback possible, so it is created owner-only and never overwritten. Each
artifact is migrated in its own transaction under its artifact row lock, and its
journal record is written and synced inside that transaction, before it commits. A
journal write that fails rolls the artifact's tier change and its access event back, so
a run that dies leaves a journal that names exactly what committed and nothing else.

A rollback record restores an artifact only when, inside the same row lock: its tier is
still `link`, this migration's access event is still the newest and the event count has
not grown, and its live link ids are exactly the ones recorded. Anything else, including
a link revoked, a link replaced, a manual tier change, a deleted artifact, an access
event that landed late from a transaction that began earlier, or a record whose
transaction never committed, is skipped and reported.

Exit codes: `0` when the command did what it reported; `1` for a usage error, a
refusal, a failure, or a rollback that skipped any artifact.

## Journal

One JSON object per line, owner-only (no group or world access). The first line is
`{"version":1,"appliedAt":"..."}`; each further line is
`{"artifactId","eventId","from","linkIds","eventCount"}`. Link ids are recorded, tokens
never are. A record the file ends in the middle of, without its closing newline, is
ignored, because a killed `apply` can leave one; a complete record that cannot be read
refuses the whole rollback before any row changes, at the end of the file as much as in
the middle.
