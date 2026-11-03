-- The three states a card grows: an expiry, and the message that answered it in chat.
SET lock_timeout = '5s';
ALTER TABLE "action_cards" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "action_cards" ADD COLUMN "answeredInChatMessageId" UUID;
ALTER TABLE "action_cards" ADD COLUMN "answeredInChatAt" TIMESTAMP(3);
RESET lock_timeout;
