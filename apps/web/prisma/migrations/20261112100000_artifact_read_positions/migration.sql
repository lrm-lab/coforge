-- An Agent's read position on an artifact: the newest version it has seen.
-- New table with its foreign key to the new table's parent; nothing existing is rewritten.
-- IF NOT EXISTS: a rerun after `prisma migrate resolve --rolled-back` finds the table the failed
-- run left, and the foreign key is then added only by the run that created it.
-- Rollback: DROP TABLE "artifact_read_positions";
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "artifact_read_positions" (
    "artifactId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    CONSTRAINT "artifact_read_positions_pkey" PRIMARY KEY ("artifactId", "agentId"),
    CONSTRAINT "artifact_read_positions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
RESET lock_timeout;
