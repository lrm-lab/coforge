-- migration-safety v1
-- checked: 2026-11-05T15:17:03.887Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-05T15:08:17.792Z production
-- body-sha256: 0b99ae02c5ce4e0ddc8001ec2ce3768924b3b55805c6f317063946c4491887eb
-- table: "tasks" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "tasks" DROP COLUMN "projectPinned";

RESET lock_timeout;
