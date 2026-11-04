-- task #529: `artifacts.access` — the read tier: `conversation` keeps reads to the home
-- conversation's readers, `workspace` widens reads to every Workspace member (writes never
-- follow the tier). A new `NOT NULL` column needs no re-write with a `DEFAULT`; `NOT VALID`
-- CHECK skips the row scan, `VALIDATE CONSTRAINT` in a later migration. The workspace-home
-- backfill runs in the next migration, not under this lock.
SET lock_timeout = '5s';
ALTER TABLE "artifacts"
  ADD COLUMN "access" text NOT NULL DEFAULT 'conversation',
  ADD CONSTRAINT "artifacts_access_check" CHECK ("access" IN ('conversation', 'workspace')) NOT VALID;
CREATE TABLE "artifact_access_events" (
  "id" uuid NOT NULL,
  "artifactId" uuid NOT NULL,
  "actorUserId" uuid,
  "actorAgentId" uuid,
  "from" text NOT NULL,
  "to" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_access_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "artifact_access_events_artifactId_createdAt_idx" ON "artifact_access_events"("artifactId", "createdAt");
ALTER TABLE "artifact_access_events" ADD CONSTRAINT "artifact_access_events_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
