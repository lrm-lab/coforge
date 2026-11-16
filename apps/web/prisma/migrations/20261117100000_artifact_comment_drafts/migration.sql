-- A person's private unsent comments on an artifact, written as one review when sent. A new table
-- whose only tie to an existing one is its foreign key to `artifacts`, so the file holds the table
-- and its indexes and nothing else: if the lock on `artifacts` times out, nothing was made and a
-- rerun starts clean.
-- Rollback: DROP TABLE "artifact_comment_drafts";
SET lock_timeout = '5s';
CREATE TABLE "artifact_comment_drafts" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "path" TEXT,
    "anchor" JSONB,
    "replyTo" UUID,
    "body" TEXT NOT NULL,
    "images" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "artifact_comment_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comment_drafts_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "artifact_comment_drafts_artifactId_userId_createdAt_id_idx" ON "artifact_comment_drafts"("artifactId", "userId", "createdAt", "id");
CREATE INDEX "artifact_comment_drafts_expiresAt_idx" ON "artifact_comment_drafts"("expiresAt");
CREATE INDEX "artifact_comment_drafts_images_idx" ON "artifact_comment_drafts" USING GIN ("images" jsonb_path_ops);
RESET lock_timeout;
