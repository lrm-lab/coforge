-- migration-safety v1
-- checked: 2026-11-05T15:17:03.853Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-05T15:08:17.792Z production
-- body-sha256: eefd2365f431ae40f9035fda1b0398b9139b1f804dec71b43b1e9ae57bb10d7e
-- table: "conversations" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "conversations" DROP COLUMN "projectId";

RESET lock_timeout;
