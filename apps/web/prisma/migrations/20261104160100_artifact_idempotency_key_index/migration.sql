-- An idempotent create's key is unique per Workspace among live artifacts (task #385): a retried
-- create hits this and returns the one it already made. Partial, like the live-name index, so a
-- soft delete releases the key and rows without a key never collide.
-- Rollback: DROP INDEX CONCURRENTLY "artifacts_idempotency_key";
CREATE UNIQUE INDEX CONCURRENTLY "artifacts_idempotency_key"
  ON "artifacts"("workspaceId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL AND "deletedAt" IS NULL;
