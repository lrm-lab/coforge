-- migration-safety v1
-- checked: 2026-11-11T08:43:45.413Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-11T04:01:09.127Z local
-- body-sha256: 79567dd29ef2e93473008335d6220a31560131ca3c3578a4416eb7320ee2633f
-- table: "tasks" rows≈-1 size=122880 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- task #61: drop the wide tasks_status_check ('todo','in_progress','in_review','done',
-- 'closed') before re-adding it with 'backlog' (the parking column). No data changes; the
-- widen is safe on any existing row. Rollback: re-add the wide CHECK.
SET lock_timeout = '5s';
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";
RESET lock_timeout;
