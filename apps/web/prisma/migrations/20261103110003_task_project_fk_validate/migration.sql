SET lock_timeout = '5s';

ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_projectId_fkey";

RESET lock_timeout;
