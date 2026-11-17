-- migration-safety v1
-- checked: 2026-11-17T06:08:38.064Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-17T00:13:17.583Z production
-- body-sha256: c7c06ab1d14ab9d70ea6824bfeba0275da57f7d6e916b4bd648c6eb3a36773a5
-- table: "agents" rows≈127 size=409600 lock=row-exclusive rewrite=yes statement=UPDATE
-- table: "agents" rows≈127 size=409600 lock=row-exclusive rewrite=yes statement=UPDATE
-- Every weekly-report Agent (each member's assistant and their collectors) wears the black mascot
-- (jing, 2026-11-17); new ones are created with it. This gives it to the existing ones whose owner
-- never picked a mascot (`avatarMascot` null), and leaves a picked one alone.
-- Rollback: none needed; a null mascot only meant "the one the id chooses".
UPDATE "agents" SET "avatarMascot" = 'black'
WHERE "avatarMascot" IS NULL
  AND "id" IN (SELECT "agentId" FROM "weekly_report_assistants");
UPDATE "agents" SET "avatarMascot" = 'black'
WHERE "avatarMascot" IS NULL
  AND "id" IN (SELECT "collectorAgentId" FROM "weekly_report_collector_bindings");
