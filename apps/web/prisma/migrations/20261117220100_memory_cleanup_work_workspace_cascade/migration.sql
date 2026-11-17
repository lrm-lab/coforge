-- migration-safety v1
-- checked: 2026-11-17T07:02:47.049Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-17T00:13:17.583Z production
-- body-sha256: d1ae6628d930f292c2d55bf3658594a8e9b9085e89a81da3d8cc6da74c5439cf
-- table: "workspace_memory_cleanup_work" rows≈-1 size=40960 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- table: "workspace_memory_cleanup_work" rows≈-1 size=40960 lock=share-row-exclusive rewrite=yes statement=ALTER TABLE ADD FOREIGN KEY
SET lock_timeout = '5s';
ALTER TABLE "workspace_memory_cleanup_work" DROP CONSTRAINT "workspace_memory_cleanup_work_workspace_id_fkey", ADD CONSTRAINT "workspace_memory_cleanup_work_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
