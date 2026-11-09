-- task #722: re-add weekly_reports_status_check narrowed to draft|submitted — NOT VALID keeps
-- the row-scan off the lock; VALIDATE follows in its own migration.
SET lock_timeout = '5s';
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_status_check"
  CHECK ("status" IN ('draft', 'submitted')) NOT VALID;
RESET lock_timeout;
