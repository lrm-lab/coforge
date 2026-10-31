SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "computers" ADD COLUMN     "lastRecovery" JSONB;

RESET lock_timeout;
