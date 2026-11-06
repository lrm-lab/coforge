-- task #601: `agent_activities.runtimeErrorRetryNotBefore` — the ISO time a retryable runtime
-- failure named as its next attempt, carried structurally so readers group usage-limit retries
-- by it instead of parsing the detail text's "(limit resets at …)" suffix. Nullable metadata-only
-- column: no default, no rewrite, the lock held only to change the catalog.
-- Rollback: ALTER TABLE "agent_activities" DROP COLUMN "runtimeErrorRetryNotBefore";
SET lock_timeout = '5s';
ALTER TABLE "agent_activities" ADD COLUMN "runtimeErrorRetryNotBefore" TEXT;
RESET lock_timeout;
