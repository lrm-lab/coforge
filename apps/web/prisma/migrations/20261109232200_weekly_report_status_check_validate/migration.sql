-- task #722: VALIDATE the CHECK `weekly_reports_status_check` without holding the ADD's lock —
-- one row scan under a short lock, then it guards new writes like any other constraint.
-- Production holds only draft/submitted rows (verified 2026-11-09).
SET lock_timeout = '5s';
ALTER TABLE "weekly_reports" VALIDATE CONSTRAINT "weekly_reports_status_check";
RESET lock_timeout;
