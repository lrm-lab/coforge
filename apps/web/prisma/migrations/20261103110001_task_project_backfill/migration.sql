-- migration-safety v1
-- checked: 2026-11-03T10:37:16.698Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-03T03:32:05.486Z production
-- body-sha256: 1adcdefcffdf05a3f3872acbd1bfc4441cc08e2215dd19e61a3031b103e3b27e
-- table: "tasks" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "tasks" t SET "projectId" = c."projectId"
FROM "conversations" c
WHERE c."id" = t."conversationId" AND c."projectId" IS NOT NULL AND t."projectId" IS NULL;
RESET lock_timeout;
