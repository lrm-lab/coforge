-- migration-safety v1
-- checked: 2026-11-12T08:51:58.589Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-11T18:08:14.242Z production
-- body-sha256: ccdcaae0edebcda947812e15a54e8a85162cc8fa3698d426c1b44c7b768e8ab1
-- table: "artifacts" rows≈-1 size=81920 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- Only Agents write an artifact now (a person only views and comments), so no row gains a person as its author. No code reads or writes the column.
-- Rollback: ALTER TABLE "artifacts" ADD COLUMN "authorUserId" UUID; (the dropped values are gone).
SET lock_timeout = '5s';

ALTER TABLE "artifacts" DROP COLUMN "authorUserId";

RESET lock_timeout;
