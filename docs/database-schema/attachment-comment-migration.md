# Attachment comment migration maintenance

This tool inspects legacy attachment discussions and rehearses their move into
ordinary source-message threads on a local database copy. It does not switch the
application's Prisma schema or read/write paths, run at startup, or execute a
production migration. Production cutover requires its separately approved backup,
write window, validation and rollback procedure.

## Commands and inputs

Run from `apps/web` with the repository's pinned Bun. Supply connection settings
through a private environment, never paste them into messages, arguments or logs.

| Command | Database input | Result |
| --- | --- | --- |
| `bun scripts/attachment-comment-migration.ts preflight` | `DATABASE_URL` | Read-only JSON plan: `ready` or `blocked`, IDs, counts and mappings |
| `bun scripts/attachment-comment-migration.ts rehearse --journal <new-private-file>` | `ATTACHMENT_MIGRATION_COPY_DATABASE_URL` | Apply to the copy, commit, restore from its journal, verify original state |
| `bun scripts/attachment-comment-migration.ts restore --journal <private-file>` | `ATTACHMENT_MIGRATION_COPY_DATABASE_URL` | Restore a previously committed copy rehearsal; repeated restore is harmless |

`ATTACHMENT_MIGRATION_SCHEMA` defaults to `public`. Names must be lowercase SQL
identifiers, at most 63 characters. A local copy must use either a database named
`coforge_attachment_rehearsal_*` or a schema named `attachment_rehearsal_*`.
Write commands accept only loopback PostgreSQL URLs, reject connection-override
query parameters, and verify the actual database and schema again inside the
transaction. The store also requires an explicit copy descriptor; omitting it
leaves inspection available and refuses writes.

Preflight exits 0 for ready and 2 for blocked. Rehearse/restore exit 0 on success;
invalid input or failure exits 1 with a bounded operator message. Raw SQL errors,
connection strings and comment bodies are not printed. A ready plan authorizes
no production operation.

## Prepare and run a local rehearsal

1. Prepare an isolated PostgreSQL copy from a consistent backup. Use PostgreSQL's
   [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html) and
   [`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html), preserving
   all relevant tables, foreign keys, indexes and identity values. Keep connection
   secrets in an owner-only password/service file or private environment. Restore
   into a marker-named local database, or into an isolated marker-named schema;
   every copied foreign key must point into the copy, never back to its source.
2. Keep the copy idle. Point `ATTACHMENT_MIGRATION_COPY_DATABASE_URL` at it. For
   preflight, point `DATABASE_URL` at that same copy and select its schema.
3. Create a private POSIX directory, mode 0700. Choose a new journal filename
   inside it; do not put it in Git, a shared folder, a report or an attachment.
4. Run preflight and examine blockers and scope. Resolve inconsistent data through
   the owning workflow; the tool does not guess missing authors or source roots.
5. Run rehearse with the new journal filename. Success reports `restored` and the
   safe plan. The private journal retains the complete before/after evidence.
6. Keep the journal and copy together until verification is accepted. Remove the
   owned database copy and its private backup/journal under the operator's retention
   policy; never remove the original database or a different operator's resources.

The journal contains full affected rows, including message bodies. Creation is
exclusive, mode 0600, with file and parent-directory fsync before the database
commit. Existing files are never overwritten. Read-back requires a regular file
with no group/other access and validates the complete versioned journal before
issuing SQL. These permission/durability guarantees are for POSIX local rehearsals.

## Data checks and preservation

Preflight rejects missing or mismatched source messages, nonordinary source
conversations, hidden conversations with unbound messages, invalid roots or
actors, cross-Workspace references, sequence overflow, nonzero historical
Message-delivery dependencies, and unknown foreign-key dependencies.

The plan keeps Message IDs, content, timestamps, authors, anchor data and every
reaction. Old roots become replies to their source Message; old nested replies
point at that same source root. Multiple attachment discussions merge in stable
sequence order after the existing source Conversation's sequence, which stays
unchanged for existing Messages. All old nested roots are cleared before moves
so cascading composite references cannot collide with target sequence values.

Existing target members retain role, mute and leftAt. A historical actor needed
by a real reference receives an inactive target seat when absent; read-only
legacy seats do not cause a join. Existing target follows stay unchanged; hidden
Conversation follows are retired without sending notifications or deliveries.
Human Read/Done cursors move only through a proven contiguous prefix and cannot
skip unread ordinary Messages. Assistant read positions use the separate private
cursor model and never advance a person's read state.

Apply locks source Conversations, Attachments and hidden Conversations in that
order and rechecks the plan. Foreign-key deferral is targeted and transaction-local;
all constraints validate before commit. The empty legacy discussion table remains
until the later schema cutover. No shared-schema DDL is applied by integration
fixtures: every fixture owns its copied schema and drops it on exit.

## Failure and restore

Each database transaction has a 30-second deadline. A failure during the apply
transaction, including inability to persist the journal, rolls back row and DDL
changes. A partial journal file may remain after file failure; retain it privately
for diagnosis and choose a fresh filename for any new rehearsal.

If apply committed but restore failed or the process was interrupted, retain the
journal and run `restore` against the same idle copy. Restore first checks database
identity and the captured rows/constraints/indexes. It does nothing when the
original state is already present, restores only the exact captured after-state,
and refuses to overwrite new Messages, changed preferences, new dependencies or
other unexpected writes. On refusal, preserve the copy and journal for analysis;
do not weaken the check or reuse the journal on a different database.

Restore reverses actor mappings, roots, sequence positions, read state and targeted
constraints, then verifies the original fingerprint. It does not delete and recreate
Message IDs or reaction rows. This is a committed-copy rollback rehearsal, not an
automatic production reverse migration after normal writes resume.

## Tests

The PostgreSQL integration tests clone the current migrated schema, including
foreign keys and indexes, into an owned schema. They compare complete row,
constraint and index inventories before/after, cover a committed apply plus
restore, inject an intermediate constraint failure and a journal-write failure,
and prove new writes block restore. CLI tests execute real Bun child processes.

With a dedicated local test database already migrated, run from `apps/web`:

```sh
mise run test:file -- ./test/attachment-comment-migration.integration.ts \
  ./test/attachment-comment-migration-actors.integration.ts \
  ./test/attachment-comment-migration-reads.integration.ts \
  ./test/attachment-comment-rehearsal.integration.ts \
  ./test/attachment-comment-migration-cli.integration.ts
```

Provide `CHANNEL_TEST_DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL` for that
dedicated database. The normal unit-test discovery does not include these
`.integration.ts` files; the explicit command is required.
