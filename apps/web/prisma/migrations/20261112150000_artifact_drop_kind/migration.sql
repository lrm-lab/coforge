-- migration-safety v1
-- checked: 2026-11-12T08:51:58.521Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-11T18:08:14.242Z production
-- body-sha256: fe7211633d8288f9a3f234d971d7128fa13a1687035599b397b293030a7e96d4
-- table: "artifacts" rows≈-1 size=81920 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
-- An artifact follows Raft: its type is its entry file's, so the column that held the kind chosen at create is dropped. No code reads or writes it.
-- Rollback: ALTER TABLE "artifacts" ADD COLUMN "kind" TEXT; (the dropped values are gone).
SET lock_timeout = '5s';

ALTER TABLE "artifacts" DROP COLUMN "kind";

RESET lock_timeout;
