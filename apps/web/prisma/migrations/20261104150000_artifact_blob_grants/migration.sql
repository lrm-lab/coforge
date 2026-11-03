-- Who may name a stored blob in a save (task #385): whoever uploaded those bytes. A save may
-- name only bytes its publisher uploaded or its artifact already uses, so a hash learned from a
-- home one cannot read does not copy its bytes into one one can write. And a document's first
-- lines, kept with the artifact for its card and list. New table, and a constant-default column.
-- Rollback: DROP TABLE "artifact_blob_grants"; ALTER TABLE "artifacts" DROP COLUMN "preview";
SET lock_timeout = '5s';
CREATE TABLE "artifact_blob_grants" (
    "workspaceId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_blob_grants_pkey" PRIMARY KEY ("workspaceId", "sha256", "actorKey"),
    CONSTRAINT "artifact_blob_grants_blob_fkey" FOREIGN KEY ("workspaceId", "sha256") REFERENCES "artifact_blobs"("workspaceId", "sha256") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "artifacts" ADD COLUMN "preview" TEXT NOT NULL DEFAULT '';
RESET lock_timeout;
