-- message_forwards."senderUserId": the person who made the forward — the carrying message's
-- sender's User id, resolved from their member row (a member row names one conversation, but the
-- forward history is the person's). Null where the sender was not a person; the picker reads it
-- by equality, so those rows never surface (task #78).
-- Rollback: ALTER TABLE "message_forwards" DROP COLUMN "senderUserId";
SET lock_timeout = '5s';
ALTER TABLE "message_forwards" ADD COLUMN "senderUserId" UUID;
RESET lock_timeout;
