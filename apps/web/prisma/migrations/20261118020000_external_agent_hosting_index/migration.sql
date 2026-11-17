CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_workspaceId_external_idx" ON "agents" ("workspaceId") WHERE "hosting" = 'external';
