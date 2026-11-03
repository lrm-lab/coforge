SET lock_timeout = '5s';

ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_priority_check";

RESET lock_timeout;
