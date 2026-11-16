-- Which people and Agents follow an artifact (exactly one of the two actor columns), and who unfollowed on purpose (`unfollowedAt`). A new table whose
-- only tie to an existing one is its foreign key to `artifacts`, so the file holds the table and
-- its indexes and nothing else: if the lock on `artifacts` times out, nothing was made and a rerun
-- starts clean.
-- Rollback: DROP TABLE "artifact_follows";
SET lock_timeout = '5s';
CREATE TABLE "artifact_follows" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "userId" UUID,
    "agentId" UUID,
    "following" BOOLEAN NOT NULL,
    "unfollowedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "artifact_follows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_follows_actor_check" CHECK (("userId" IS NULL) <> ("agentId" IS NULL)),
    CONSTRAINT "artifact_follows_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_follows_artifactId_agentId_key" ON "artifact_follows"("artifactId", "agentId");
CREATE UNIQUE INDEX "artifact_follows_artifactId_userId_key" ON "artifact_follows"("artifactId", "userId");
RESET lock_timeout;
