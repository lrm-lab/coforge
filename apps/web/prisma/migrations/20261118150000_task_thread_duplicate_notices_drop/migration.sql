-- migration-safety v1
-- checked: 2026-11-18T13:11:21.273Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-18T01:04:18.010Z production
-- body-sha256: c3c4b828447641f2f0788262adfc8c73561fed4d10f2c4d532d1bf1356e63a97
-- table: "messages" rows≈20744 size=101359616 lock=row-exclusive rewrite=yes statement=DELETE
DELETE FROM "messages" m
USING "system_messages" s, "conversations" c
WHERE s."messageId" = m."id"
  AND s."conversationId" = m."conversationId"
  AND c."id" = m."conversationId"
  AND c."kind" = 'task_thread'
  AND s."kind" IN ('task.moved', 'task.claimed', 'task.unassigned')
  AND NOT EXISTS (SELECT 1 FROM "messages" r WHERE r."threadRootId" = m."id")
  AND NOT EXISTS (SELECT 1 FROM "tasks" t WHERE t."messageId" = m."id" OR t."sourceMessageId" = m."id")
  AND NOT EXISTS (SELECT 1 FROM "reminders" rm WHERE rm."messageId" = m."id")
  AND NOT EXISTS (SELECT 1 FROM "artifacts" a WHERE a."originMessageId" = m."id");
