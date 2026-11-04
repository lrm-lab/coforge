SET lock_timeout = '5s';

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_role_check" CHECK ("role" IS NULL OR "role" IN ('engineer', 'designer', 'product', 'marketing', 'research', 'founder')) NOT VALID;

RESET lock_timeout;
