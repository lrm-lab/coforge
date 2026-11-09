-- `agents.runtimeConfigRevision`: the per-Agent order of runtime config changes, which a Daemon uses
-- to drop an out-of-date config push. A constant default, so no rewrite and no backfill; the lock is
-- held only to change the catalog.
-- Rollback: ALTER TABLE "agents" DROP COLUMN "runtimeConfigRevision";
SET lock_timeout = '5s';
ALTER TABLE "agents" ADD COLUMN "runtimeConfigRevision" INTEGER NOT NULL DEFAULT 0;
RESET lock_timeout;
