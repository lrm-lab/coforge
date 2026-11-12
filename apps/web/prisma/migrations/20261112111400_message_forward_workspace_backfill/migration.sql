-- migration-safety v1
-- checked: 2026-11-12T11:45:45.375Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-12T09:00:16.753Z production
-- body-sha256: ac8423a37b5672bf555e653977c65aec4c514b4e16c774ab9a5b1e98a71eb602
-- table: "message_forwards" rows≈6 size=65536 lock=row-exclusive rewrite=yes statement=UPDATE
-- message_forwards."workspaceId" release two (task #93): fill the rows a pre-#78 Web instance
-- or the column-add window wrote without it, so the next migration can SET NOT NULL in any
-- environment — staging and dev databases never saw production's backfill.
-- The value comes from conversations, not messages: a forward's source conversation and its
-- carrying message are always in the actor's one Workspace (cross-workspace forward does not
-- exist), and conversations is small enough for migration-safety while messages (~95 MB in
-- production) earns a rewrite verdict — the same refusal that pulled 20261111033020.
-- A row whose source conversation was already deleted matches nothing and stays NULL; the
-- SET NOT NULL after this then fails loudly instead of deleting data. Escape: fill that row
-- by hand from its message (UPDATE "message_forwards" f SET "workspaceId" = m."workspaceId"
-- FROM "messages" m WHERE f."messageId" = m."id" AND f."workspaceId" IS NULL) and resolve.
-- Rollback: the filled values are denormalized copies of the messages'; dropping them again
-- (UPDATE "message_forwards" SET "workspaceId" = NULL WHERE true) restores the prior state,
-- though nothing reads NULLs as meaningful.
UPDATE "message_forwards" f
SET "workspaceId" = c."workspaceId"
FROM "conversations" c
WHERE f."workspaceId" IS NULL AND c."id" = f."sourceConversationId";
