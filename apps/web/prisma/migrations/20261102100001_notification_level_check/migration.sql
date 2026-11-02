SET lock_timeout = '5s';

ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_notification_level_check" CHECK ("notificationLevel" IN ('all', 'relevant', 'none', 'muted')) NOT VALID;

RESET lock_timeout;
