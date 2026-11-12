-- A review: several comments written at once. A new table whose only tie to an existing one is
-- its foreign key to `artifacts`, so the file holds the table and its indexes and nothing else:
-- if the lock on `artifacts` times out, nothing was made and a rerun starts clean.
-- Rollback: DROP TABLE "artifact_comment_reviews";
SET lock_timeout = '5s';
CREATE TABLE "artifact_comment_reviews" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "authorUserId" UUID,
    "authorAgentId" UUID,
    "body" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_comment_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comment_reviews_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_comment_reviews_artifactId_authorAgentId_idempoten_key" ON "artifact_comment_reviews"("artifactId", "authorAgentId", "idempotencyKey");
CREATE UNIQUE INDEX "artifact_comment_reviews_artifactId_authorUserId_idempotenc_key" ON "artifact_comment_reviews"("artifactId", "authorUserId", "idempotencyKey");
RESET lock_timeout;
