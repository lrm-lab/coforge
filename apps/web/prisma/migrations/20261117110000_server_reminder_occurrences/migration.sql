SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "workspace_computers" ADD COLUMN     "readyCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "readyStartedAt" BIGINT,
ADD COLUMN     "readyWorkerInstanceId" TEXT;

-- CreateTable
CREATE TABLE "reminder_occurrences" (
    "id" UUID NOT NULL,
    "reminderId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "payload" BYTEA NOT NULL,

    CONSTRAINT "reminder_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminder_occurrences_status_expiresAt_idx" ON "reminder_occurrences"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "reminder_occurrences_workspaceId_computerId_status_idx" ON "reminder_occurrences"("workspaceId", "computerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_reminderId_version_key" ON "reminder_occurrences"("reminderId", "version");

-- AddForeignKey
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_reminderId_workspaceId_fkey" FOREIGN KEY ("reminderId", "workspaceId") REFERENCES "reminders"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "reminder_occurrences" ADD COLUMN     "nextPublishAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "reminder_occurrences_status_nextPublishAt_idx" ON "reminder_occurrences"("status", "nextPublishAt");

RESET lock_timeout;
