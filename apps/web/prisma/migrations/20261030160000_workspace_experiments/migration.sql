-- Experiments are a Workspace's switch (owner or admin), not a person's. This only adds the column;
-- `user_preferences.experiments` (never read in production: the flag is off there) stays until the
-- release after this one is live, so a container still running the old code keeps working while
-- this runs (expand-contract). A later migration drops it.
-- Rollback: ALTER TABLE "workspaces" DROP COLUMN "experiments";
ALTER TABLE "workspaces" ADD COLUMN "experiments" JSONB;
