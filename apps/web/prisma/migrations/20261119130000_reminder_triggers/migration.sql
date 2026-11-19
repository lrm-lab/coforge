-- Rollback: DROP TABLE "reminder_trigger_events"; DROP TABLE "reminder_triggers"; ALTER TABLE "reminders" DROP CONSTRAINT "reminders_kind_shape", DROP COLUMN "kind", DROP COLUMN "triggerKey", DROP COLUMN "details"; run DELETE FROM "reminders" WHERE "kind" = 'trigger' first; "messageId" NOT NULL is not restored.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'scheduled',
ADD COLUMN     "triggerKey" VARCHAR(64),
ADD COLUMN     "details" TEXT,
ALTER COLUMN "messageId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "reminder_triggers" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "ownerAgentId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "level" TEXT NOT NULL,
    "mergeWindowSeconds" INTEGER NOT NULL,
    "windowEndsAt" TIMESTAMP(3),
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "firstPendingAt" TIMESTAMP(3),
    "lastPendingAt" TIMESTAMP(3),
    "lastWokeAt" TIMESTAMP(3),
    "reminderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_trigger_events" (
    "id" UUID NOT NULL,
    "triggerId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "ownerAgentId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requestId" VARCHAR(128) NOT NULL,
    "triggerCount" INTEGER NOT NULL,
    "firstTriggeredAt" TIMESTAMP(3) NOT NULL,
    "lastTriggeredAt" TIMESTAMP(3) NOT NULL,
    "nextWakeAllowedAt" TIMESTAMP(3),

    CONSTRAINT "reminder_trigger_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_triggers_workspaceId_ownerAgentId_key_key" ON "reminder_triggers"("workspaceId", "ownerAgentId", "key");

-- CreateIndex
CREATE INDEX "reminder_trigger_events_triggerId_at_idx" ON "reminder_trigger_events"("triggerId", "at" DESC);

-- CreateIndex
CREATE INDEX "reminder_trigger_events_workspaceId_ownerAgentId_at_idx" ON "reminder_trigger_events"("workspaceId", "ownerAgentId", "at");

-- CreateIndex
CREATE INDEX "reminder_trigger_events_at_idx" ON "reminder_trigger_events"("at");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_trigger_events_triggerId_requestId_key" ON "reminder_trigger_events"("triggerId", "requestId");

-- AddForeignKey
ALTER TABLE "reminder_triggers" ADD CONSTRAINT "reminder_triggers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_triggers" ADD CONSTRAINT "reminder_triggers_ownerAgentId_workspaceId_fkey" FOREIGN KEY ("ownerAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_triggers" ADD CONSTRAINT "reminder_triggers_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_trigger_events" ADD CONSTRAINT "reminder_trigger_events_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "reminder_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_trigger_events" ADD CONSTRAINT "reminder_trigger_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reminder_triggers" ADD CONSTRAINT "reminder_triggers_level_check" CHECK ("level" IN ('wake', 'log')),
ADD CONSTRAINT "reminder_triggers_window_check" CHECK ("mergeWindowSeconds" BETWEEN 60 AND 86400),
ADD CONSTRAINT "reminder_triggers_pending_check" CHECK ("pendingCount" >= 0);

ALTER TABLE "reminder_trigger_events" ADD CONSTRAINT "reminder_trigger_events_outcome_check" CHECK ("outcome" IN ('woke', 'merged', 'recorded', 'throttled')),
ADD CONSTRAINT "reminder_trigger_events_level_check" CHECK ("level" IN ('wake', 'log'));

ALTER TABLE "reminders" ADD CONSTRAINT "reminders_kind_shape" CHECK (("kind" = 'scheduled' AND "messageId" IS NOT NULL AND "triggerKey" IS NULL AND "details" IS NULL) OR ("kind" = 'trigger' AND "triggerKey" IS NOT NULL)) NOT VALID;

RESET lock_timeout;
