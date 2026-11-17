-- Rollback: DROP TABLE "external_agent_push_webhooks".
SET lock_timeout = '5s';
CREATE TABLE "external_agent_push_webhooks" (
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "disabledReason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "rejectionStreak" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3),
    "retryNoticeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_agent_push_webhooks_pkey" PRIMARY KEY ("agentId"),
    CONSTRAINT "external_agent_push_webhooks_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "external_agent_push_webhooks_disabledReason_check" CHECK ("disabledReason" IS NULL OR "disabledReason" IN ('endpoint_rejected', 'endpoint_invalid', 'agent_unavailable'))
);
RESET lock_timeout;
