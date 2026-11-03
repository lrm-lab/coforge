-- The version a version went back to, when it was made by going back (task #385): the history
-- marks it. Nullable, no default: no rewrite.
-- Rollback: ALTER TABLE "artifact_versions" DROP COLUMN "revertedFrom";
SET lock_timeout = '5s';
ALTER TABLE "artifact_versions" ADD COLUMN "revertedFrom" INTEGER;
RESET lock_timeout;
