CREATE INDEX CONCURRENTLY "agent_message_deliveries_agent_created_idx" ON "agent_message_deliveries"("agentId", "conversationId", "createdAt");
