-- migration-safety v1
-- checked: 2026-11-12T08:51:58.617Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-11T18:08:14.242Z production
-- body-sha256: 3cca2b9e2ffc8d4f5299245466861629c84e2fec4940276c8c92f7e98d3d48b8
-- table: "artifact_versions" rows≈-1 size=65536 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- Only Agents publish a version now (a person only views and comments), so no row gains a person as its publisher. No code reads or writes the column.
-- Rollback: ALTER TABLE "artifact_versions" ADD COLUMN "publisherUserId" UUID; (the dropped values are gone).
SET lock_timeout = '5s';

ALTER TABLE "artifact_versions" DROP COLUMN "publisherUserId";

RESET lock_timeout;
