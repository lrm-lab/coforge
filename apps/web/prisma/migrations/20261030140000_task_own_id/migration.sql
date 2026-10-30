-- A Task gets an id of its own, so a task may exist without a message in the channel. Every
-- existing task keeps its old key as its id (id = messageId), so nothing that names a task changes.
ALTER TABLE "tasks" ADD COLUMN "id" UUID;
UPDATE "tasks" SET "id" = "messageId";
ALTER TABLE "tasks" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "task_history_events" DROP CONSTRAINT "task_history_events_taskMessageId_fkey";
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_taskMessageId_conversationId_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_pkey";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");
ALTER TABLE "tasks" ALTER COLUMN "messageId" DROP NOT NULL;
CREATE UNIQUE INDEX "tasks_messageId_key" ON "tasks"("messageId");

ALTER TABLE "task_history_events" RENAME COLUMN "taskMessageId" TO "taskId";
ALTER INDEX "task_history_events_taskMessageId_seq_key" RENAME TO "task_history_events_taskId_seq_key";
ALTER INDEX "task_history_events_taskMessageId_createdAt_idx" RENAME TO "task_history_events_taskId_createdAt_idx";
ALTER TABLE "task_history_events"
  ADD CONSTRAINT "task_history_events_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_execution_sessions" RENAME COLUMN "taskMessageId" TO "taskId";
ALTER INDEX "task_execution_sessions_taskMessageId_agentId_key" RENAME TO "task_execution_sessions_taskId_agentId_key";
ALTER TABLE "task_execution_sessions"
  ADD CONSTRAINT "task_execution_sessions_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
