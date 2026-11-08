-- migration-safety v1
-- checked: 2026-11-08T04:26:20.156Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-08T04:06:24.125Z production
-- body-sha256: d42f11af769afb9709789411644b407882e8f38fd090baa5a192bb752108b6b9
-- table: "weekly_reports" rows≈10 size=180224 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "weekly_reports" SET "status" = 'submitted' WHERE "status" = 'shared';
RESET lock_timeout;
