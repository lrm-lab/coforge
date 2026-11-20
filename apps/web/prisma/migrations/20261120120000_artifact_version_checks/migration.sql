-- Automated headless-browser publish checks for HTML artifact versions. A new table whose only
-- tie to an existing table is its foreign key to `artifacts`, guarded by a 5s lock timeout.
-- Rollback: DROP TABLE "artifact_version_checks";
SET lock_timeout = '5s';
CREATE TABLE "artifact_version_checks" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "errorClass" TEXT,
    "findings" JSONB,
    "screenshots" JSONB NOT NULL DEFAULT '[]',
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "artifact_version_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_version_checks_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'skipped')),
    CONSTRAINT "artifact_version_checks_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_version_checks_artifactId_version_key" ON "artifact_version_checks"("artifactId", "version");
CREATE INDEX "artifact_version_checks_status_createdAt_idx" ON "artifact_version_checks"("status", "createdAt");
CREATE INDEX "artifact_version_checks_screenshots_idx" ON "artifact_version_checks" USING GIN ("screenshots" jsonb_path_ops);
RESET lock_timeout;
