-- A web page's shared data store: one row per (collection, docId) of an artifact, written by one person or Agent (exactly one of the two actor columns). A new table whose
-- only tie to an existing one is its foreign key to `artifacts`, so the file holds the table and
-- its index and nothing else: if the lock on `artifacts` times out, nothing was made and a rerun
-- starts clean.
-- Rollback: DROP TABLE "artifact_page_documents";
SET lock_timeout = '5s';
CREATE TABLE "artifact_page_documents" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sizeBytes" INTEGER NOT NULL,
    "userId" UUID,
    "agentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "artifact_page_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_page_documents_actor_check" CHECK (("userId" IS NULL) <> ("agentId" IS NULL)),
    CONSTRAINT "artifact_page_documents_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_page_documents_artifactId_collection_docId_key" ON "artifact_page_documents"("artifactId", "collection", "docId");
RESET lock_timeout;
