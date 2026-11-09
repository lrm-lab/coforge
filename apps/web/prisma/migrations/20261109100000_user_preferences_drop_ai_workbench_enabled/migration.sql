-- migration-safety v1
-- checked: 2026-11-09T13:14:37.744Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-09T05:54:47.238Z production
-- body-sha256: f3913b6d9b15309cafa9977dc34f0c26bab45c214398f6f757a9704bda5f9531
-- table: "user_preferences" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- task #43: AI Workbench became a Workspace experiment (`workspaces.experiments.aiWorkbench`), so the
-- account-level `user_preferences.aiWorkbenchEnabled` (task #743, never deployed) is dropped. No
-- stored value is migrated. Dropping a column is a catalog change; the lock is held only briefly.
-- Rollback: ALTER TABLE "user_preferences" ADD COLUMN "aiWorkbenchEnabled" BOOLEAN;
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" DROP COLUMN "aiWorkbenchEnabled";
RESET lock_timeout;
