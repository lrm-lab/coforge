SET lock_timeout = '5s';
ALTER TABLE "tasks" RENAME CONSTRAINT "tasks_status_backlog_check" TO "tasks_status_check";
RESET lock_timeout;
