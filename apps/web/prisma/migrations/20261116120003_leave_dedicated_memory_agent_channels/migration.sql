-- migration-safety v1
-- checked: 2026-11-16T10:46:09.142Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: 1efdbee91f376b8cb935fe58526f36a7dfdf9542aea0c0514b5ec055dda785a8
-- table: "conversation_members" rows≈2357 size=1171456 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "conversation_members" SET "leftAt" = now()
WHERE "agentId" IN (SELECT "agent_id" FROM "workspace_memory_agents") AND "leftAt" IS NULL;
RESET lock_timeout;
