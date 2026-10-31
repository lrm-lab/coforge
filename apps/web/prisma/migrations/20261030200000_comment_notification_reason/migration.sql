SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "pending_mention_actions" ADD COLUMN "reason" TEXT,
ADD CONSTRAINT "pending_mention_actions_reason_check" CHECK ("reason" IN ('mentioned', 'subscribed')) NOT VALID;

-- AlterTable
ALTER TABLE "agent_message_deliveries" ADD COLUMN "reason" TEXT,
ADD CONSTRAINT "agent_message_deliveries_reason_check" CHECK ("reason" IN ('mentioned', 'subscribed')) NOT VALID;

RESET lock_timeout;
