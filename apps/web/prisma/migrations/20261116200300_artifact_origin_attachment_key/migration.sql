-- One live artifact per saved attachment. CREATE INDEX CONCURRENTLY cannot run in a transaction or
-- beside another statement, so it stands alone with no lock_timeout wrapper.
-- Rollback: DROP INDEX CONCURRENTLY "artifacts_origin_attachment_live_key";
CREATE UNIQUE INDEX CONCURRENTLY "artifacts_origin_attachment_live_key"
  ON "artifacts"("workspaceId", "originAttachmentId")
  WHERE "originAttachmentId" IS NOT NULL AND "deletedAt" IS NULL;
