CREATE INDEX CONCURRENTLY "team_memory_entries_workspace_id_project_id_status_updated__idx" ON "team_memory_entries"("workspace_id", "project_id", "status", "updated_at");
