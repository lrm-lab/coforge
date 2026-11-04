-- AlterTable
SET lock_timeout = '5s';
ALTER TABLE "agent_api_keys" ADD COLUMN     "firstUsedAt" TIMESTAMP(3);
RESET lock_timeout;
