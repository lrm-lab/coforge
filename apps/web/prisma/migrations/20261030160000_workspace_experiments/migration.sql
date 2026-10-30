-- Experiments are a Workspace's switch (owner or admin), not a person's. The personal column was
-- only ever written from Settings behind the `task-conversations` flag; no value is carried over.
-- Rollback: ALTER TABLE "workspaces" DROP COLUMN "experiments";
--           ALTER TABLE "user_preferences" ADD COLUMN "experiments" JSONB;
ALTER TABLE "workspaces" ADD COLUMN "experiments" JSONB;
ALTER TABLE "user_preferences" DROP COLUMN "experiments";
