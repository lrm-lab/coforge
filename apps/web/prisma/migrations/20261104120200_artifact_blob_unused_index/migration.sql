-- The sweep of unused artifact blobs reads only blobs no version has named, oldest use first
-- (task #385), so its cost follows the blobs waiting to go, not every blob stored.
-- Rollback: DROP INDEX CONCURRENTLY "artifact_blobs_unused_idx";
CREATE INDEX CONCURRENTLY "artifact_blobs_unused_idx" ON "artifact_blobs"("lastUsedAt") WHERE "referenced" = false;
