-- Comments on artifacts. A new table, with foreign keys to `artifacts`, to itself (a thread's
-- root) and to the reviews table of the migration before; the file holds the table and its
-- indexes and nothing else, so a lock timeout leaves nothing behind and a rerun starts clean.
-- Rollback: DROP TABLE "artifact_comments";
SET lock_timeout = '5s';
CREATE TABLE "artifact_comments" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "path" TEXT,
    "anchor" JSONB,
    "rootId" UUID,
    "reviewId" UUID,
    "authorUserId" UUID,
    "authorAgentId" UUID,
    "body" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" UUID,
    "resolvedByAgentId" UUID,
    CONSTRAINT "artifact_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comments_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comments_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "artifact_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comments_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "artifact_comment_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "artifact_comments_artifactId_createdAt_id_idx" ON "artifact_comments"("artifactId", "createdAt", "id");
CREATE INDEX "artifact_comments_artifactId_path_idx" ON "artifact_comments"("artifactId", "path");
CREATE INDEX "artifact_comments_rootId_idx" ON "artifact_comments"("rootId");
CREATE INDEX "artifact_comments_reviewId_idx" ON "artifact_comments"("reviewId");
CREATE UNIQUE INDEX "artifact_comments_artifactId_authorAgentId_idempotencyKey_key" ON "artifact_comments"("artifactId", "authorAgentId", "idempotencyKey");
CREATE UNIQUE INDEX "artifact_comments_artifactId_authorUserId_idempotencyKey_key" ON "artifact_comments"("artifactId", "authorUserId", "idempotencyKey");
RESET lock_timeout;
