SET lock_timeout = '5s';

CREATE TABLE "agent_mute_hints" (
    "agentId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "agent_mute_hints_pkey" PRIMARY KEY ("agentId", "conversationId")
);

CREATE INDEX "agent_mute_hints_workspaceId_idx" ON "agent_mute_hints"("workspaceId");

RESET lock_timeout;
