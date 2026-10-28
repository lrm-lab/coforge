ALTER TABLE "agent_message_deliveries" ADD COLUMN "taskExecutionSignal" JSONB;
DROP INDEX "task_execution_sessions_taskMessageId_agentId_key";
CREATE UNIQUE INDEX "task_execution_sessions_taskMessageId_agentId_attempt_key" ON "task_execution_sessions"("taskMessageId", "agentId", "attempt");
