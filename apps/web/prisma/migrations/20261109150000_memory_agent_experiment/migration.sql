-- migration-safety v1
-- checked: 2026-11-09T13:54:54.377Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-09T05:54:47.238Z production
-- body-sha256: 45e1f909dd7c57c282673fdf50f1b832d4293ab404728d268f6735f902ef92fb
-- table: "workspaces" rows≈-1 size=49152 lock=row-exclusive rewrite=yes statement=UPDATE
-- Task #6: the Memory Agent becomes a Workspace experiment, and a Workspace whose Memory Agent is
-- still live keeps it. The switch defaults to off for every Workspace that has none, so only those
-- with a live Memory Agent are written: new Workspaces stay off until someone switches it on.
--
-- A soft-deleted Agent does not count: `workspace_memory_agents` keeps its row after a soft delete
-- (the next attach clears it), and `liveMemoryAgentId` reads such a Workspace as having none. The
-- JOIN asks the same question, so the backfill and the code agree on what "already has one" means.
UPDATE "workspaces" w
SET "experiments" = COALESCE(w."experiments", '{}'::jsonb)
      || jsonb_build_object('memoryAgent', true)
WHERE COALESCE(w."experiments" ->> 'memoryAgent', '') = ''
  AND EXISTS (
    SELECT 1
    FROM "workspace_memory_agents" m
    JOIN "agents" a ON a."id" = m."agent_id"
    WHERE m."workspace_id" = w."id"
      AND a."deletedAt" IS NULL
  );
