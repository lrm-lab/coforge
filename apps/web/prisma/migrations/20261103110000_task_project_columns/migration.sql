SET lock_timeout = '5s';

ALTER TABLE "tasks" ADD COLUMN "projectId" UUID,
ADD COLUMN "projectPinned" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
