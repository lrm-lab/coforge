SET lock_timeout = '5s';

ALTER TABLE "agents" ADD COLUMN "createRequestId" UUID;

RESET lock_timeout;
