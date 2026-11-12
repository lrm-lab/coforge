-- An Agent's comment position on an artifact: the last comment it was shown (time and id, the
-- order comments are listed in), beside its version position in a table of its own. A new table
-- whose only tie to an existing one is its foreign key to `artifacts`, so the file holds the table
-- and nothing else: if the lock on `artifacts` times out, nothing was made and a rerun starts
-- clean. No row means the Agent has seen no comment.
-- Rollback: DROP TABLE "artifact_comment_positions";
SET lock_timeout = '5s';
CREATE TABLE "artifact_comment_positions" (
    "artifactId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "seenId" UUID NOT NULL,
    CONSTRAINT "artifact_comment_positions_pkey" PRIMARY KEY ("artifactId", "agentId"),
    CONSTRAINT "artifact_comment_positions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
RESET lock_timeout;
