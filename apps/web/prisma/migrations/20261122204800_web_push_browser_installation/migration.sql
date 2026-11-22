-- Existing subscriptions and older clients leave the installation ID unset.
-- Rollback: ALTER TABLE "web_push_subscriptions" DROP COLUMN "browserInstallationId";
SET lock_timeout = '5s';
ALTER TABLE "web_push_subscriptions" ADD COLUMN "browserInstallationId" UUID;
RESET lock_timeout;
