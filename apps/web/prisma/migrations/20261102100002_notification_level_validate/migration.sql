SET lock_timeout = '5s';

ALTER TABLE "conversation_members" VALIDATE CONSTRAINT "conversation_members_notification_level_check";

RESET lock_timeout;
