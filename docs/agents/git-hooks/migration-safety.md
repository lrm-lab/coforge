# Migration safety

Part of [Git hooks](README.md), the rule `migration-safety` of the [hard rules](hard-rules.md).

A migration that locks or rewrites a table with data can stall the running version for as long as
it waits for the lock or rewrites. The check reads the SQL, asks what each statement does to which
table, and judges that against how big the table is in production. It builds on the expand-contract
rules of [`check-migration-safety.sh`](../../../scripts/deploy/check-migration-safety.sh)
(additive changes first, destructive ones in a later release).

## What is high risk

A statement is high risk when it targets a table that existed before the migration (one `CREATE
TABLE`d earlier in the same file is empty and unseen, so it is not):

- `ALTER TABLE`: `ADD COLUMN` with a volatile default, generated or identity column, a
  constraint on the column, or `NOT NULL` without a default; `ALTER COLUMN TYPE`; `SET NOT NULL`;
  `ADD PRIMARY KEY`, `UNIQUE` (without `USING INDEX`), `FOREIGN KEY` or `CHECK` without `NOT VALID`;
  `DROP COLUMN`, `DROP CONSTRAINT`, renames of a table or column.
- `DROP TABLE` (`CASCADE` adds what depends on it), `TRUNCATE`, `LOCK TABLE`, `CREATE INDEX`
  without `CONCURRENTLY`, and every `UPDATE`, `DELETE` and `INSERT ... SELECT`: a `WHERE` does not
  make a big table safe, so these are judged by the table's size like the rest (a `WHERE` that is
  trivially true, such as `(true)` or `1 = 1`, only changes the label). A statement that reads
  other tables (`INSERT ... SELECT`, `UPDATE ... FROM`, `DELETE ... USING`, a `JOIN` or subquery)
  is judged by the largest of the tables it names after `FROM`, `JOIN` and `USING` and its target.
- `ADD COLUMN` of a `serial` type or with any default that calls a function outside `now()` and the
  other statement-time ones, however the function is spelled (quoted, schema-qualified).
- Any statement the check does not recognise (`DO` blocks, `EXECUTE`, `WITH ...`, triggers,
  `SELECT`): it may do anything.

Comments, string literals, quoted identifiers and dollar-quoted bodies are never mistaken for
statements (`scripts/migration-safety/tokenize.ts`). Semantics are PostgreSQL 18.0's: a constant
default does not rewrite, a volatile one does.

A migration with no high-risk statement needs nothing. `CREATE INDEX CONCURRENTLY` and
`DROP INDEX CONCURRENTLY` (both `SHARE UPDATE EXCLUSIVE`, so neither needs a lock_timeout) must be
the only statement of their file.

## lock_timeout

Production's `lock_timeout` is 0: a statement waits for its lock forever, and everything queued
behind it waits too. **Every** statement that takes a blocking lock (`ACCESS EXCLUSIVE`,
`EXCLUSIVE`, `SHARE ROW EXCLUSIVE`, `SHARE`) on a table that exists needs `SET lock_timeout = '5s';`
(at most `10s`) in force before it. That includes plain `ADD COLUMN`, `DROP INDEX`, `NOT VALID`
constraints, `RENAME CONSTRAINT`, `OWNER TO`, `ENABLE`/`DISABLE TRIGGER`, and `CREATE TABLE` with a
foreign key to, or `PARTITION OF`, an existing table. Only statements on a table the same file
creates, and a bare `CREATE TABLE`, are exempt. The message names the statement that needs it.
Anything the check does not recognise (`set_config`, a `DO` block, `ALTER ROLE ... SET`) may change
the setting, so what follows it counts as unguarded.

- **Session form only.** Prisma `migrate deploy` runs a migration file outside a transaction block,
  so `SET LOCAL` has no effect: verified against PostgreSQL 18.6 by
  `scripts/migration-safety/lock-timeout.integration.ts`, where `SET lock_timeout = '2s'` made the
  migration fail after 2.4 s with `canceling statement due to lock timeout` and `SET LOCAL` left it
  waiting. Run it with
  `MIGRATION_SAFETY_ADMIN_URL=postgresql://... bun test ./scripts/migration-safety/lock-timeout.integration.ts`
  against a scratch PostgreSQL 18; `mise run test` does not discover it.
- **End with `RESET lock_timeout;`.** The setting stays on the connection for the migration files
  that follow; a file that sets one must end with the reset.
- **A guarded high-risk statement stands alone.** With no transaction, a timeout that fires leaves
  the rest of the file half applied, and a failed row in `_prisma_migrations` blocks the next deploy
  until `prisma migrate resolve --rolled-back <name>`. So a file whose high-risk statement needs the
  timeout contains exactly `SET lock_timeout`, that one statement, and `RESET lock_timeout`; split
  anything else into other files, and the rerun after `resolve` is clean. Files whose guarded
  statements are all low risk may hold several.

## Verdicts

A table is large at 100,000 estimated rows (`reltuples`) or
64 MiB (`pg_total_relation_size`). A table never analysed (`reltuples` -1) has no row estimate and
is judged by its size alone. A table the snapshot lacks counts as large unless another migration
creates it. An unrecognised statement that mentions any catalog table (inside strings and `DO`
bodies too) is judged by the largest such table, and counts as large when it mentions none. A
partitioned table counts as the sum of its partitions. Contract steps (`DROP COLUMN`, `RENAME`) only
take the lock, so on a large table they judge `ok-with-lock-timeout`: annotate them, and give them
a `lock_timeout` in a file of their own.

| Verdict                | When                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rewrite`              | A high-risk statement that rewrites or scans the whole table hits a large table. Rewrite the migration in steps: expand-contract, `NOT VALID` then `VALIDATE CONSTRAINT`, `CONCURRENTLY`, batched `UPDATE ... WHERE`. |
| `ok-with-lock-timeout` | Otherwise, with a blocking lock: the migration must set the lock_timeout.                                                                                                                                             |
| `ok`                   | Otherwise.                                                                                                                                                                                                            |

## The annotation

A migration with a high-risk statement starts with the check's annotation (comments only: the
checked time, `pg: 18.0`, the verdict, the snapshot's time and environment, a SHA-256 of the body
below it, and one `table:` line per high-risk statement with rows, size, lock and rewrite).
`bun scripts/migration-safety/check-migration.ts --write --snapshot <snapshot.json> <migration.sql>`
writes it (and refuses a `rewrite`). Do not edit the body afterwards: the hash fails.

| Mode                               | Checks                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verify <file>...`               | Offline: the format, the hash, that the lines describe the statements, no `rewrite`, a lock_timeout where required.                                                                     |
| `--ci --snapshot <file> <file>...` | `--verify`, plus the verdict and locks recomputed from the snapshot. Row and size drift passes unless it changes the verdict. A missing, unreadable or over 14 days old snapshot fails. |
| `--deploy`                         | On the host, see below.                                                                                                                                                                 |

The rule applies only to migrations a commit or range adds, never to ones already in the base, and
never to a migration whose directory name is at or before `LAST_GRANDFATHERED_MIGRATION`
(`scripts/migration-safety/grandfather.ts`: the last directory on `origin/main` when the check
began; the deploy gate skips them too). Pre-commit has no snapshot and runs the `--verify` checks.
In CI, the hard rule downloads the newest unexpired `catalog-snapshot-production` artifact from a
run on `main` (`gh api repos/<repo>/actions/artifacts?name=...`) into `MIGRATION_SAFETY_SNAPSHOT`,
only for a migration that needs a verdict; with none (a pull request from a fork) a high-risk
migration fails and the rest pass. A snapshot older than 14 days fails too: deploy to refresh it
(see the Deploy workflow's snapshot artifact). `check-migration-safety.sh` has no bypass any more:
a deliberate breaking change is annotated and judged by the deploy gate.

## The catalog snapshot

After a deploy has been verified healthy, `deploy-staging.yml` and `deploy-production.yml` run the
local action `.github/actions/catalog-snapshot` over the SSH identity they already hold: it runs
`scripts/deploy/catalog-snapshot.sh` on the host, which runs `migration-safety/catalog-snapshot.ts`
in the `migrate` container with the deploy's own `DATABASE_URL`, validates the JSON, and uploads
`catalog-snapshot-staging` or `catalog-snapshot-production` (kept 30 days). A failed snapshot does
not fail the deployment. The JSON holds table names, estimated rows and total bytes: no row, column
value or connection string. To use the latest one: `gh run download <run> --name catalog-snapshot-production`.

## The deploy gate

`migrate-deploy.sh` runs in the `migrate` container of `remote-deploy.sh` (staging and production)
before `prisma migrate deploy`: `check-migration.ts --deploy` lists the migrations
`_prisma_migrations` has not finished, and for each one with a high-risk statement re-judges it
against the live `pg_class` (not a snapshot) and verifies the annotation. A missing annotation, a
different verdict, `rewrite`, or a live catalog it cannot read stops the deploy before any
migration runs; the running version keeps serving, and the failure names the file and the two ways
out (`--write` against the latest snapshot, or rewrite in steps).

## Sources

- [Explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html) (lock modes and
  which statements take them) and [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html)
  (which forms rewrite or scan).
- [`lock_timeout`](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-LOCK-TIMEOUT)
  and [`SET`](https://www.postgresql.org/docs/18/sql-set.html) (`SET LOCAL` is for the current transaction).
- [`CREATE INDEX CONCURRENTLY`](https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).
- [`pg_class.reltuples`](https://www.postgresql.org/docs/18/catalog-pg-class.html).
