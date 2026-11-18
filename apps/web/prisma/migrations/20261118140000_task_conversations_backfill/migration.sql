-- migration-safety v1
-- checked: 2026-11-18T08:51:26.646Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-18T01:04:18.010Z production
-- body-sha256: 4a51980430f33e39d1d16c2037e56535503663c6ed94924cf7e2c6e1033c3e4c
-- table: "*" rows≈933 size=401408 lock=access-exclusive rewrite=yes statement=unrecognised statement
SET lock_timeout = '5s';
WITH "pending" AS (
  SELECT "id" AS "taskId", "workspaceId", uuidv7() AS "conversationId"
  FROM "tasks"
  WHERE "discussionConversationId" IS NULL
  FOR UPDATE
),
"made" AS (
  INSERT INTO "conversations" ("id", "workspaceId", "kind")
  SELECT "conversationId", "workspaceId", 'task_thread' FROM "pending"
  RETURNING "id"
)
UPDATE "tasks" t
SET "discussionConversationId" = p."conversationId"
FROM "pending" p
WHERE t."id" = p."taskId"
  AND t."discussionConversationId" IS NULL;
RESET lock_timeout;
