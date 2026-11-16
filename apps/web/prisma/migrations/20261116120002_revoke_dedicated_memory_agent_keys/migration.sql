-- migration-safety v1
-- checked: 2026-11-16T10:46:09.142Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: 9c58198e59255b1e62862be88148e8a70fbe934b3928c45a9ecdf591e3879d24
-- table: "agent_api_keys" rows≈4121 size=1974272 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "agent_api_keys" SET "revokedAt" = now()
WHERE "agentId" IN (SELECT "agent_id" FROM "workspace_memory_agents") AND "revokedAt" IS NULL;
RESET lock_timeout;
