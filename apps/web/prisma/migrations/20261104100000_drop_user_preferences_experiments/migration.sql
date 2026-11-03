-- migration-safety v1
-- checked: 2026-11-03T14:01:41.399Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-03T03:32:05.486Z production
-- body-sha256: e89fdd4d10c19b5c810f5dd30c2fbbcd11dfef4b558033697de1ea658b218531
-- table: "user_preferences" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- Destructive: drops "user_preferences"."experiments", the contract step of task #343's
-- expand-contract (20261030160000_workspace_experiments moved experiments to the Workspace and left
-- this column for one release). The model dropped it on 2026-10-30 (9149e6f50), so no build since
-- then selects it, and both releases after it are live. Production never read it (the flag was off).
-- Rollback: ALTER TABLE "user_preferences" ADD COLUMN "experiments" JSONB; (the values are gone).
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" DROP COLUMN "experiments";
RESET lock_timeout;
