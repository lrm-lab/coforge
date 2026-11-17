SET lock_timeout = '5s';
ALTER TABLE "artifacts" ALTER COLUMN "kind" DROP NOT NULL;
RESET lock_timeout;
