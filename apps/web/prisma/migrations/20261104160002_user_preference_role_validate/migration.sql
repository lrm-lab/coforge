SET lock_timeout = '5s';

ALTER TABLE "user_preferences" VALIDATE CONSTRAINT "user_preferences_role_check";

RESET lock_timeout;
