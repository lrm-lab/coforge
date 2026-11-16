SET lock_timeout = '5s';
CREATE TABLE "team_memory_states" (
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "team_memory_states_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE "team_memory_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "applicability" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "author_agent_id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_memory_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "team_memory_versions" (
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actor_agent_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "merged_from" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memory_versions_pkey" PRIMARY KEY ("workspace_id","entry_id","revision")
);

CREATE TABLE "team_memory_receipts" (
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "review_token" UUID,
    "review_revision" INTEGER NOT NULL DEFAULT 0,
    "review_expires_at" TIMESTAMP(3),
    "fingerprint" TEXT NOT NULL,
    "entry_id" UUID,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memory_receipts_pkey" PRIMARY KEY ("workspace_id","agent_id","request_id")
);

CREATE INDEX "team_memory_entries_workspace_id_status_updated_at_idx" ON "team_memory_entries"("workspace_id", "status", "updated_at");

CREATE INDEX "team_memory_entries_search_text_idx" ON "team_memory_entries" USING GIN ("search_text" gin_trgm_ops);

CREATE UNIQUE INDEX "team_memory_entries_workspace_id_id_key" ON "team_memory_entries"("workspace_id", "id");

CREATE UNIQUE INDEX "team_memory_entries_workspace_id_dedup_key_key" ON "team_memory_entries"("workspace_id", "dedup_key");

CREATE INDEX "team_memory_receipts_workspace_id_agent_id_review_expires_a_idx" ON "team_memory_receipts"("workspace_id", "agent_id", "review_expires_at");

ALTER TABLE "team_memory_states" ADD CONSTRAINT "team_memory_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_memory_entries" ADD CONSTRAINT "team_memory_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_memory_versions" ADD CONSTRAINT "team_memory_versions_workspace_id_entry_id_fkey" FOREIGN KEY ("workspace_id", "entry_id") REFERENCES "team_memory_entries"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_memory_receipts" ADD CONSTRAINT "team_memory_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
