-- Each browser subscription says whether it is a phone or a computer, what to call it, and how its
-- last deliveries went (task #467). All nullable, no default: no rewrite.
-- Rollback: ALTER TABLE "web_push_subscriptions" DROP COLUMN "deviceKind", DROP COLUMN "deviceLabel",
-- DROP COLUMN "lastFailureAt", DROP COLUMN "lastFailureReason", DROP COLUMN "lastSuccessAt";
SET lock_timeout = '5s';
ALTER TABLE "web_push_subscriptions" ADD COLUMN "deviceKind" TEXT,
ADD COLUMN "deviceLabel" TEXT,
ADD COLUMN "lastFailureAt" TIMESTAMP(3),
ADD COLUMN "lastFailureReason" TEXT,
ADD COLUMN "lastSuccessAt" TIMESTAMP(3);
RESET lock_timeout;
