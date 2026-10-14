ALTER TABLE "agent_activities"
ADD COLUMN "conversationId" UUID,
ADD COLUMN "conversationTarget" TEXT;
