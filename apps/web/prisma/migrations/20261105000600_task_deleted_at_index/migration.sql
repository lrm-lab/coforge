-- migration-safety v1
-- checked: 2026-11-04T10:00:00.000Z  pg: 18.0  verdict: ok
-- task #512: the deleted-task sweep reads marked rows; a partial index carries only those.
-- CREATE INDEX CONCURRENTLY cannot run in a transaction or beside another statement, so it
-- stands alone here with no lock_timeout wrapper.
CREATE INDEX CONCURRENTLY "tasks_deletedAt_idx" ON "tasks" ("deletedAt") WHERE "deletedAt" IS NOT NULL;
