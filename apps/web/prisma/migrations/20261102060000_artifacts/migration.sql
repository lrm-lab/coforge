SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "homeKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "entryPath" TEXT NOT NULL,
    "authorUserId" UUID,
    "authorAgentId" UUID,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" UUID,
    "deletedByAgentId" UUID,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_versions" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "publisherUserId" UUID,
    "publisherAgentId" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "entryPath" TEXT NOT NULL,
    "changedPaths" JSONB NOT NULL,
    "merged" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_files" (
    "versionId" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "artifact_files_pkey" PRIMARY KEY ("versionId", "path")
);

-- CreateTable
CREATE TABLE "artifact_blobs" (
    "workspaceId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_blobs_pkey" PRIMARY KEY ("workspaceId", "sha256")
);

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_workspaceId_homeKey_name_key" ON "artifacts"("workspaceId", "homeKey", "name");

-- CreateIndex
CREATE INDEX "artifacts_workspaceId_homeKey_idx" ON "artifacts"("workspaceId", "homeKey");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_versions_artifactId_number_key" ON "artifact_versions"("artifactId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_versions_artifactId_idempotencyKey_key" ON "artifact_versions"("artifactId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "artifact_files_artifactId_sha256_idx" ON "artifact_files"("artifactId", "sha256");

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "artifact_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_blobs" ADD CONSTRAINT "artifact_blobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
