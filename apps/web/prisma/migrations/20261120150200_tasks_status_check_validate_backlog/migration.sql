SET lock_timeout = '5s';
ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_status_backlog_check";
RESET lock_timeout;
