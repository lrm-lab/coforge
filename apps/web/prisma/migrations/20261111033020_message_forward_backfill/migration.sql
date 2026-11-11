-- migration-safety v1
-- checked: 2026-11-11T04:01:33.663Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-11T04:01:09.127Z local
-- body-sha256: e6721b96866aeddab884f84a989f4acf673f639ea2926263bd4f3350576192ca
-- table: "message_forwards" rows≈-1 size=24576 lock=row-exclusive rewrite=yes statement=UPDATE
-- Backfills the two columns 20261111033000 and 20261111033010 added: each forward row takes the
-- Workspace of the message that carries it and that message's sender's User id (task #78). The
-- WHERE keeps a rerun after a partial apply from rewriting rows it already filled.
-- Rollback: UPDATE "message_forwards" SET "workspaceId" = NULL, "senderUserId" = NULL; (the
-- columns are dropped by the earlier migrations' rollbacks)
SET lock_timeout = '5s';
UPDATE "message_forwards" AS f
SET "workspaceId" = m."workspaceId", "senderUserId" = cm."userId"
FROM "messages" AS m
LEFT JOIN "conversation_members" AS cm
  ON cm."id" = m."senderMemberId"
 AND cm."conversationId" = m."conversationId"
 AND cm."workspaceId" = m."workspaceId"
WHERE f."messageId" = m."id" AND f."workspaceId" IS NULL;
RESET lock_timeout;
