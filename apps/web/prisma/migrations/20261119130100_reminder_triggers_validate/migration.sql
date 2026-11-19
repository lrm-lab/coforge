SET lock_timeout = '5s';
ALTER TABLE "reminders" VALIDATE CONSTRAINT "reminders_kind_shape";
RESET lock_timeout;
