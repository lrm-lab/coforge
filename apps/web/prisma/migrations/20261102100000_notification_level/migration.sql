SET lock_timeout = '5s';

ALTER TABLE "conversation_members" ADD COLUMN "notificationLevel" TEXT NOT NULL DEFAULT 'all';

RESET lock_timeout;
