-- A bound installation is unique within its user account.
-- Rollback: DROP INDEX CONCURRENTLY "web_push_subscriptions_userId_browserInstallationId_key";
CREATE UNIQUE INDEX CONCURRENTLY "web_push_subscriptions_userId_browserInstallationId_key"
ON "web_push_subscriptions"("userId", "browserInstallationId");
