-- migration-safety v1
-- checked: 2026-11-06T20:19:47.663Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-06T17:40:08.153Z production
-- body-sha256: 0b99ae02c5ce4e0ddc8001ec2ce3768924b3b55805c6f317063946c4491887eb
-- table: "tasks" rows≈713 size=1712128 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "tasks" DROP COLUMN "projectPinned";

RESET lock_timeout;
