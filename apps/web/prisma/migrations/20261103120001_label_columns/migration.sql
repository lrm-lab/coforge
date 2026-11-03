SET lock_timeout = '5s';

ALTER TABLE "labels" ADD COLUMN "description" TEXT,
ADD COLUMN "groupId" UUID,
ADD COLUMN "archivedAt" TIMESTAMP(3);

RESET lock_timeout;
