-- migration-safety v1
-- checked: 2026-11-20T14:04:01.104Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-19T01:46:41.103Z production
-- body-sha256: e78898db9478ae11d516bf424f481773b539a4307dfeddb58817d8dae8b7f159
-- table: "tasks" rows≈485 size=2334720 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";
RESET lock_timeout;
