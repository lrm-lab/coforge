-- What an artifact blob is, text or binary, decided by the server from its bytes at upload; the
-- object its bytes are in; when it was last uploaded or saved into a version; and whether a
-- version has named it. The last two pick what the sweep of unused blobs removes (task #385).
-- The `kind` and `objectKey` defaults only fill rows that exist (none in production) and are
-- dropped at once, so every upload states both. Metadata-only: constant and `now()` defaults
-- with NOT NULL need no rewrite.
-- Rollback: ALTER TABLE "artifact_blobs" DROP COLUMN "kind", DROP COLUMN "objectKey", DROP COLUMN "lastUsedAt", DROP COLUMN "referenced";
SET lock_timeout = '5s';
ALTER TABLE "artifact_blobs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'binary',
ADD COLUMN "objectKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "referenced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "artifact_blobs" ALTER COLUMN "kind" DROP DEFAULT,
ALTER COLUMN "objectKey" DROP DEFAULT;
ALTER TABLE "artifact_blobs" ADD CONSTRAINT "artifact_blobs_kind_check" CHECK ("kind" IN ('text', 'binary')) NOT VALID;
ALTER TABLE "artifact_blobs" VALIDATE CONSTRAINT "artifact_blobs_kind_check";
RESET lock_timeout;
