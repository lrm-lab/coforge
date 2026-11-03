-- The blob sweep asks whether any version still names a blob (task #385): by sha256, across a
-- Workspace's artifacts.
-- Rollback: DROP INDEX CONCURRENTLY "artifact_files_sha256_idx";
CREATE INDEX CONCURRENTLY "artifact_files_sha256_idx" ON "artifact_files"("sha256");
