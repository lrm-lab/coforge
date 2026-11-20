SET lock_timeout = '5s';
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_backlog_check" CHECK ("status" IN ('backlog', 'todo', 'in_progress', 'done', 'closed')) NOT VALID;
RESET lock_timeout;
