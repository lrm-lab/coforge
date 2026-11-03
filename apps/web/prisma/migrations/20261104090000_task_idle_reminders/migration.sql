-- CreateTable
CREATE TABLE "task_idle_reminders" (
    "agentId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "remindedAt" TIMESTAMP(3) NOT NULL,
    "staleRemindedAt" TIMESTAMP(3),

    CONSTRAINT "task_idle_reminders_pkey" PRIMARY KEY ("agentId","taskId")
);

-- CreateIndex
CREATE INDEX "task_idle_reminders_agentId_remindedAt_idx" ON "task_idle_reminders"("agentId", "remindedAt" DESC);

-- CreateIndex
CREATE INDEX "task_idle_reminders_taskId_idx" ON "task_idle_reminders"("taskId");

-- AddForeignKey
ALTER TABLE "task_idle_reminders" ADD CONSTRAINT "task_idle_reminders_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_idle_reminders" ADD CONSTRAINT "task_idle_reminders_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
