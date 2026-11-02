SET lock_timeout = '5s';

ALTER TABLE "agent_message_deliveries" VALIDATE CONSTRAINT "agent_message_deliveries_reason_check";

RESET lock_timeout;
