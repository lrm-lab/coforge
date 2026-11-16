-- Pictures attached to artifact comments. A new table whose only ties to existing ones are its
-- foreign keys to `artifacts` and `artifact_comments`, so the file holds the table and its
-- indexes and nothing else: if a lock times out, nothing was made and a rerun starts clean.
-- Rollback: DROP TABLE "artifact_comment_images";
SET lock_timeout = '5s';
CREATE TABLE "artifact_comment_images" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_comment_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comment_images_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comment_images_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "artifact_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "artifact_comment_images_commentId_position_idx" ON "artifact_comment_images"("commentId", "position");
CREATE INDEX "artifact_comment_images_artifactId_idx" ON "artifact_comment_images"("artifactId");
RESET lock_timeout;
