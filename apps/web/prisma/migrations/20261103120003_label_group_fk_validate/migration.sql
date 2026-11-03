SET lock_timeout = '5s';

ALTER TABLE "labels" VALIDATE CONSTRAINT "labels_groupId_fkey";

RESET lock_timeout;
