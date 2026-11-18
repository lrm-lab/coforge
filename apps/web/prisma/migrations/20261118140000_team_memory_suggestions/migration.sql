CREATE TABLE "team_memory_suggestions" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "source_key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  "decided_by_user_id" UUID,
  "applied_entry_id" UUID,
  CONSTRAINT "team_memory_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_memory_suggestions_workspace_id_source_key_key"
  ON "team_memory_suggestions"("workspace_id", "source_key");
CREATE INDEX "team_memory_suggestions_workspace_id_status_created_at_id_idx"
  ON "team_memory_suggestions"("workspace_id", "status", "created_at", "id");

CREATE TABLE "team_memory_review_scans" (
  "workspace_id" UUID NOT NULL,
  "scanned_at" TIMESTAMP(3) NOT NULL,
  "cursor_at" TIMESTAMP(3),
  "cursor_id" UUID,
  CONSTRAINT "team_memory_review_scans_pkey" PRIMARY KEY ("workspace_id")
);
ALTER TABLE "team_memory_suggestions"
  ADD CONSTRAINT "team_memory_suggestions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_memory_review_scans"
  ADD CONSTRAINT "team_memory_review_scans_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
