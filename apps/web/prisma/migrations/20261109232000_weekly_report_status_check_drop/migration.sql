-- migration-safety v1
-- checked: 2026-11-09T23:17:31.870Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-09T05:54:47.238Z production
-- body-sha256: 3b0e9e6df3d0bf30ec5b967073aa81d28a1bcbc1e68a450ed4f336a4f988b117
-- table: "weekly_reports" rows≈10 size=180224 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- task #722: drop the wide weekly_reports_status_check (allowed 'shared') before re-adding it
-- narrowed to draft|submitted — data was normalized by 20261108120000. Rollback: re-add the
-- wide CHECK ('draft','submitted','shared').
SET lock_timeout = '5s';
ALTER TABLE "weekly_reports" DROP CONSTRAINT "weekly_reports_status_check";
RESET lock_timeout;
