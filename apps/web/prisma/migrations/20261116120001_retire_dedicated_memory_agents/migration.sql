-- migration-safety v1
-- checked: 2026-11-16T10:46:09.142Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: c0c9111f7d3c54c8e8dc822f963f919ebc1467fd265ed877f069fa16a7d657e0
-- table: "agents" rows≈127 size=409600 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "agents" SET "stoppedAt" = COALESCE("stoppedAt", now()), "deletedAt" = COALESCE("deletedAt", now()), "controlState" = NULL
WHERE "id" IN (SELECT "agent_id" FROM "workspace_memory_agents") AND "deletedAt" IS NULL;
RESET lock_timeout;
