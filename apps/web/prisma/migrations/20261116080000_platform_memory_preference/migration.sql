SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "platformMemoryEnabled" BOOLEAN;

RESET lock_timeout;
