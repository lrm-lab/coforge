CREATE UNIQUE INDEX CONCURRENTLY "artifacts_home_live_name_key"
  ON "artifacts"("workspaceId", "homeKey", "name")
  WHERE "deletedAt" IS NULL;
