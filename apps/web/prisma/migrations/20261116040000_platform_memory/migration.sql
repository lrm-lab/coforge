SET lock_timeout = '5s';

CREATE TABLE "platform_memory_heads" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "agentId" UUID,
    "author" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "createRequestId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "uri" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sourceMessageId" UUID,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_memory_heads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_memory_scope_check" CHECK (("scope" = 'team' AND "agentId" IS NULL) OR ("scope" = 'agent' AND "agentId" IS NOT NULL)),
    CONSTRAINT "platform_memory_kind_check" CHECK ("kind" IN ('fact', 'experience', 'preference')),
    CONSTRAINT "platform_memory_revision_check" CHECK ("revision" >= 0)
);

CREATE TABLE "platform_memory_receipts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "entryId" UUID NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_memory_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_memory_heads_workspaceId_author_createRequestId_key" ON "platform_memory_heads"("workspaceId", "author", "createRequestId");
CREATE UNIQUE INDEX "platform_memory_heads_workspaceId_dedupKey_key" ON "platform_memory_heads"("workspaceId", "dedupKey");
CREATE INDEX "platform_memory_heads_scope_updated_idx" ON "platform_memory_heads"("workspaceId", "scope", "agentId", "updatedAt", "id");
CREATE UNIQUE INDEX "platform_memory_receipts_workspaceId_actor_requestId_key" ON "platform_memory_receipts"("workspaceId", "actor", "requestId");

ALTER TABLE "platform_memory_heads" ADD CONSTRAINT "platform_memory_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_memory_receipts" ADD CONSTRAINT "platform_memory_receipts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "platform_memory_keys" (
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "entryId" UUID NOT NULL,
    CONSTRAINT "platform_memory_keys_pkey" PRIMARY KEY ("workspaceId", "key")
);
CREATE INDEX "platform_memory_keys_entryId_idx" ON "platform_memory_keys"("entryId");
ALTER TABLE "platform_memory_keys" ADD CONSTRAINT "platform_memory_keys_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "platform_memory_heads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
