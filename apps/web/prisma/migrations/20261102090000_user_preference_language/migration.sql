SET lock_timeout = '5s';

ALTER TABLE "user_preferences" ADD COLUMN "language" TEXT;

RESET lock_timeout;
