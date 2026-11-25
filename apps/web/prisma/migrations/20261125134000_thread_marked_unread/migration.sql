SET lock_timeout = '5s';
ALTER TABLE "thread_reads" ADD COLUMN "markedUnreadVersion" UUID;
RESET lock_timeout;
