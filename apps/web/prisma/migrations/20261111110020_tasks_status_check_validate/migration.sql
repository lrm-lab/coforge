-- task #61: VALIDATE the CHECK `tasks_status_check` without holding the ADD's lock — one row
-- scan under a short lock, then it guards new writes like any other constraint. Every stored
-- status is from the old set, which the widened one contains, so the scan passes.
SET lock_timeout = '5s';
ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_status_check";
RESET lock_timeout;
