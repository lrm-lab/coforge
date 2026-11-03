-- A card that expires wakes its Agent with a delivery of its own reason.
SET lock_timeout = '5s';
ALTER TABLE "agent_message_deliveries" ADD CONSTRAINT "agent_message_deliveries_reason_check"
  CHECK ("reason" IN ('mentioned', 'subscribed', 'choice', 'expired')) NOT VALID;
RESET lock_timeout;
