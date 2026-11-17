CREATE INDEX CONCURRENTLY "team_memory_maintenance_candidates_idx" ON "team_memory_entries"("workspace_id", "project_id", "updated_at", "id") WHERE ("status" = 'active' AND "pinned" = false);
