-- Rollback: ALTER TABLE "external_agent_push_webhooks" DROP COLUMN "unauthorizedSince", DROP COLUMN "disabledAt", DROP COLUMN "nextProbeAt", DROP COLUMN "probeAttempts", DROP COLUMN "probeStoppedAt".
SET lock_timeout = '5s';
ALTER TABLE "external_agent_push_webhooks"
    ADD COLUMN "unauthorizedSince" TIMESTAMP(3),
    ADD COLUMN "disabledAt" TIMESTAMP(3),
    ADD COLUMN "nextProbeAt" TIMESTAMP(3),
    ADD COLUMN "probeAttempts" INTEGER,
    ADD COLUMN "probeStoppedAt" TIMESTAMP(3);
RESET lock_timeout;
