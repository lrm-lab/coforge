SET lock_timeout = '5s';
ALTER TABLE "artifact_follows"
  ADD COLUMN "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "doneAt" TIMESTAMP(3);
RESET lock_timeout;
