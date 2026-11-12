SET lock_timeout = '5s';
ALTER TABLE "thread_follows" ADD COLUMN "unfollowedAt" TIMESTAMP(3);
RESET lock_timeout;
