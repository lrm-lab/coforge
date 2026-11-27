CREATE INDEX CONCURRENTLY "computer_attach_sessions_target_expiry_idx" ON "computer_attach_sessions"("target_workspace_id", "expires_at");
