SET lock_timeout = '5s';

ALTER TABLE "tasks" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'none';

RESET lock_timeout;
