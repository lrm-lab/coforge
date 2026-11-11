-- task #61: re-add tasks_status_check widened with 'backlog' — NOT VALID keeps the row scan
-- off the lock; VALIDATE follows in its own migration.
SET lock_timeout = '5s';
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check"
  CHECK ("status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'closed')) NOT VALID;
RESET lock_timeout;
