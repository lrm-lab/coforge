-- A person's place on an artifact: when they last opened it, the newest version they have seen, and
-- the last comment they were shown, beside the Agents' positions. A new table whose only tie to an
-- existing one is its foreign key to `artifacts`, so the file holds the table and its index and
-- nothing else: if the lock on `artifacts` times out, nothing was made and a rerun starts clean.
-- Rollback: DROP TABLE "artifact_viewer_positions";
SET lock_timeout = '5s';
CREATE TABLE "artifact_viewer_positions" (
    "artifactId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "seenVersion" INTEGER NOT NULL,
    "commentSeenAt" TIMESTAMP(3),
    "commentSeenId" UUID,
    CONSTRAINT "artifact_viewer_positions_pkey" PRIMARY KEY ("artifactId", "userId"),
    CONSTRAINT "artifact_viewer_positions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "artifact_viewer_positions_userId_openedAt_idx" ON "artifact_viewer_positions"("userId", "openedAt" DESC);
RESET lock_timeout;
