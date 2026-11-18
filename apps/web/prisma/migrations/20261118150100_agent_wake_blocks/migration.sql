-- Why a message delivery left an Agent un-woken, and how many arrived while that reason held.
-- Rollback: ALTER TABLE "agents" DROP COLUMN "wakeBlockedReason", DROP COLUMN "wakeBlockedCount", DROP COLUMN "wakeBlockedAt";
SET lock_timeout = '5s';

ALTER TABLE "agents" ADD COLUMN     "wakeBlockedReason" TEXT,
ADD COLUMN     "wakeBlockedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wakeBlockedAt" TIMESTAMP(3);

RESET lock_timeout;
