-- Reverting: while every task still has a message (messageId IS NOT NULL), rename taskId back to
-- taskMessageId on task_history_events and task_execution_sessions, restore their foreign keys to
-- tasks("messageId"), make "messageId" NOT NULL and the primary key again, and drop "id".

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
CREATE UNIQUE INDEX "tasks_id_conversationId_key" ON "tasks"("id", "conversationId");

-- The finished-task pages order by (updatedAt, id) now.
DROP INDEX "tasks_workspaceId_status_updatedAt_messageId_idx";
DROP INDEX "tasks_conversationId_status_updatedAt_messageId_idx";
CREATE INDEX "tasks_workspaceId_status_updatedAt_id_idx" ON "tasks"("workspaceId", "status", "updatedAt" DESC, "id" DESC);
CREATE INDEX "tasks_conversationId_status_updatedAt_id_idx" ON "tasks"("conversationId", "status", "updatedAt" DESC, "id" DESC);

ALTER TABLE "task_history_events" RENAME COLUMN "taskMessageId" TO "taskId";
ALTER INDEX "task_history_events_taskMessageId_seq_key" RENAME TO "task_history_events_taskId_seq_key";
ALTER INDEX "task_history_events_taskMessageId_createdAt_idx" RENAME TO "task_history_events_taskId_createdAt_idx";
ALTER TABLE "task_history_events"
  ADD CONSTRAINT "task_history_events_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_execution_sessions" RENAME COLUMN "taskMessageId" TO "taskId";
ALTER INDEX "task_execution_sessions_taskMessageId_agentId_key" RENAME TO "task_execution_sessions_taskId_agentId_key";
ALTER TABLE "task_execution_sessions"
  ADD CONSTRAINT "task_execution_sessions_taskId_conversationId_fkey"
  FOREIGN KEY ("taskId", "conversationId") REFERENCES "tasks"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
