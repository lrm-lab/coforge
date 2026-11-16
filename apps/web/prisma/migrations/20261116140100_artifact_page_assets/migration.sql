-- The files a web page adds to its own library at run time: one row per (artifact, name), the bytes an artifact blob named by `sha256`. A new table whose
-- only tie to an existing one is its foreign key to `artifacts`, so the file holds the table and
-- its index and nothing else: if the lock on `artifacts` times out, nothing was made and a rerun
-- starts clean.
-- Rollback: DROP TABLE "artifact_page_assets";
SET lock_timeout = '5s';
CREATE TABLE "artifact_page_assets" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "uploadedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_page_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_page_assets_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_page_assets_artifactId_name_key" ON "artifact_page_assets"("artifactId", "name");
RESET lock_timeout;
