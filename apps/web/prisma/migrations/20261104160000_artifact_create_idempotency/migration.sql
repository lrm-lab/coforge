-- An idempotent create records the client's key and a hash of the create's inputs (task #385), so
-- a retried create returns the artifact it already made instead of a second one. Both nullable,
-- no default: no rewrite, and existing rows stay null (made before this, or by a path that sends
-- no key).
-- Rollback: ALTER TABLE "artifacts" DROP COLUMN "idempotencyKey", DROP COLUMN "requestHash";
SET lock_timeout = '5s';
ALTER TABLE "artifacts" ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "requestHash" TEXT;
RESET lock_timeout;
