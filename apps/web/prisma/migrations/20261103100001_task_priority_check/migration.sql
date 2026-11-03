SET lock_timeout = '5s';

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("priority" IN ('urgent', 'high', 'medium', 'low', 'none')) NOT VALID;

RESET lock_timeout;
