SET lock_timeout = '5s';

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_language_check" CHECK ("language" IS NULL OR "language" IN ('en', 'zh-CN')) NOT VALID;

RESET lock_timeout;
