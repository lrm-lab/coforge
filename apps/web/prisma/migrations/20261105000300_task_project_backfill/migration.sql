-- migration-safety v1
-- checked: 2026-11-04T04:34:02.236Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-04T03:33:16.527Z production
-- body-sha256: 3d3aeabfae09320f0b51377b4c1b463dcdb718b1c57a267dc5066b20ec520997
-- table: "tasks" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
-- task #484: Tasks carry their own Project. A Task that followed its channel's Project gets the
-- channel's projectId copied onto itself; one explicitly pinned keeps what it had.
SET lock_timeout = '5s';
UPDATE "tasks" t SET "projectId" = c."projectId"
  FROM "conversations" c
  WHERE t."conversationId" = c."id"
    AND t."projectPinned" = false
    AND c."projectId" IS NOT NULL
    AND t."projectId" IS DISTINCT FROM c."projectId";
RESET lock_timeout;
