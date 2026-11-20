-- migration-safety v1
-- checked: 2026-11-20T14:04:00.957Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-19T01:46:41.103Z production
-- body-sha256: c7b838fa2d9b883e873806c423f1eddd21dc4a7d6c61b26950efdb7970e5ed4d
-- table: "tasks" rows≈485 size=2334720 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
UPDATE "tasks" SET "status" = 'in_progress' WHERE "status" = 'in_review';
RESET lock_timeout;
