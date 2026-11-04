SET lock_timeout = '5s';

ALTER TABLE "user_preferences" ADD COLUMN "role" TEXT;

ALTER TABLE "workspace_member_preferences" ADD COLUMN "onboardingPendingSince" TIMESTAMP(3);

RESET lock_timeout;
