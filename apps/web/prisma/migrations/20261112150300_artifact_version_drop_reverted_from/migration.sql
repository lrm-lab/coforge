-- migration-safety v1
-- checked: 2026-11-12T08:51:58.649Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-11T18:08:14.242Z production
-- body-sha256: f3f75f305230ceadaf4243c6c656c1d6c092c4b29f11d741dddc7d3e4df5f851
-- table: "artifact_versions" rows≈-1 size=65536 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- There is no revert of a version (Raft has none), so the column that marked one is dropped. No code reads or writes it.
-- Rollback: ALTER TABLE "artifact_versions" ADD COLUMN "revertedFrom" INTEGER; (the dropped values are gone).
SET lock_timeout = '5s';

ALTER TABLE "artifact_versions" DROP COLUMN "revertedFrom";

RESET lock_timeout;
