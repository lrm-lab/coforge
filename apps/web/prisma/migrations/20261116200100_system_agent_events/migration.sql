-- The notices a built-in source (such as `system.artifacts`) sends to an Agent, one row per notice
-- with the Message it became; `externalEventId` is unique per source and Agent so a retried
-- delivery stores one. A new table whose ties to existing ones are its foreign keys, so the file
-- holds the table and its indexes and nothing else.
-- Rollback: DROP TABLE "system_agent_events";
SET lock_timeout = '5s';
CREATE TABLE "system_agent_events" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_agent_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_agent_events_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "system_agent_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "system_agent_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "system_agent_events_messageId_key" ON "system_agent_events"("messageId");
CREATE UNIQUE INDEX "system_agent_events_source_agentId_externalEventId_key" ON "system_agent_events"("source", "agentId", "externalEventId");
CREATE INDEX "system_agent_events_agentId_idx" ON "system_agent_events"("agentId");
CREATE INDEX "system_agent_events_workspaceId_idx" ON "system_agent_events"("workspaceId");
RESET lock_timeout;
