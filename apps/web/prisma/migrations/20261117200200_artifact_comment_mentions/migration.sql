SET lock_timeout = '5s';
CREATE TABLE "artifact_comment_mentions" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "commentId" UUID,
    "reviewId" UUID,
    "mentionedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "artifact_comment_mentions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comment_mentions_target_check" CHECK (("commentId" IS NULL) <> ("reviewId" IS NULL)),
    CONSTRAINT "artifact_comment_mentions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comment_mentions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "artifact_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comment_mentions_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "artifact_comment_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_comment_mentions_comment_key" ON "artifact_comment_mentions"("commentId", "userId") WHERE "commentId" IS NOT NULL;
CREATE UNIQUE INDEX "artifact_comment_mentions_review_key" ON "artifact_comment_mentions"("reviewId", "userId") WHERE "reviewId" IS NOT NULL;
CREATE INDEX "artifact_comment_mentions_artifactId_userId_mentionedAt_idx" ON "artifact_comment_mentions"("artifactId", "userId", "mentionedAt" DESC);
RESET lock_timeout;
