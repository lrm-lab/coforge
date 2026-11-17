-- migration-safety v1
-- checked: 2026-11-18T10:01:00.000Z  pg: 18.0  verdict: ok
-- task #13: partial index on open due tasks for the 60s due-notification worker.
-- CREATE INDEX CONCURRENTLY cannot run in a transaction or beside another statement, so it
-- stands alone here with no lock_timeout wrapper.
CREATE INDEX CONCURRENTLY "tasks_dueAt_open_idx" ON "tasks" ("dueAt") WHERE "dueAt" IS NOT NULL AND "status" NOT IN ('done', 'closed');
