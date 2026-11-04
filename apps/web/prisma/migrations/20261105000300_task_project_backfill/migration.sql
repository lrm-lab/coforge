-- migration-safety v1
-- checked: 2026-11-04T03:35:22.153Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-04T03:33:16.527Z production
-- body-sha256: d344f6196ce008a5405ad9325dc07f76b59a8f2c2d4598d1dec6b80b8a8a89b5
-- table: "tasks" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
-- task #484: Tasks carry their own Project. A Task that followed its channel's Project gets the
-- channel's projectId copied onto itself; one explicitly pinned keeps what it had.
SET lock_timeout = '5s';
UPDATE "tasks" t SET "projectId" = c."projectId"
  FROM "conversations" c
  WHERE t."conversationId" = c."id"
    AND t."projectPinned" = false
    AND c."projectId" IS NOT NULL;
RESET lock_timeout;
