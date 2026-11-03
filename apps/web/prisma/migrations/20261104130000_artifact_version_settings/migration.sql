-- Each artifact version records the title and description it left, so a save over an older
-- version merges them item by item against its base (task #385). Metadata-only: constant
-- defaults with NOT NULL need no rewrite; the table is empty in production.
-- Rollback: ALTER TABLE "artifact_versions" DROP COLUMN "title", DROP COLUMN "description";
SET lock_timeout = '5s';
ALTER TABLE "artifact_versions" ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN "description" TEXT NOT NULL DEFAULT '';
RESET lock_timeout;
