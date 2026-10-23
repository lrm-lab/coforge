
-- CreateTable
CREATE TABLE "app_agent_inbound_grants" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scopes" TEXT[],
    "source" TEXT NOT NULL,
    "grantedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,

    CONSTRAINT "app_agent_inbound_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_agent_inbound_requests" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" UUID,
    "exchangedAt" TIMESTAMP(3),

    CONSTRAINT "app_agent_inbound_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_agent_events" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "externalEventId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_agent_inbound_grants_agentId_idx" ON "app_agent_inbound_grants"("agentId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_grants_workspaceId_idx" ON "app_agent_inbound_grants"("workspaceId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_grants_grantedByUserId_idx" ON "app_agent_inbound_grants"("grantedByUserId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_grants_revokedByUserId_idx" ON "app_agent_inbound_grants"("revokedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_inbound_grants_appId_agentId_key" ON "app_agent_inbound_grants"("appId", "agentId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_requests_agentId_createdAt_idx" ON "app_agent_inbound_requests"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "app_agent_inbound_requests_workspaceId_idx" ON "app_agent_inbound_requests"("workspaceId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_requests_appId_idx" ON "app_agent_inbound_requests"("appId");

-- CreateIndex
CREATE INDEX "app_agent_inbound_requests_decidedByUserId_idx" ON "app_agent_inbound_requests"("decidedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_inbound_requests_one_pending" ON "app_agent_inbound_requests"("appId", "agentId") WHERE ("status" = 'pending');

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_events_messageId_key" ON "app_agent_events"("messageId");

-- CreateIndex
CREATE INDEX "app_agent_events_agentId_createdAt_idx" ON "app_agent_events"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "app_agent_events_workspaceId_idx" ON "app_agent_events"("workspaceId");

-- CreateIndex
CREATE INDEX "app_agent_events_appId_idx" ON "app_agent_events"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_events_appId_agentId_externalEventId_key" ON "app_agent_events"("appId", "agentId", "externalEventId");

-- AddForeignKey
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_events" ADD CONSTRAINT "app_agent_events_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_events" ADD CONSTRAINT "app_agent_events_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_events" ADD CONSTRAINT "app_agent_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_events" ADD CONSTRAINT "app_agent_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints
ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_source_check" CHECK (
    "source" IN ('automatic', 'approval')
);

ALTER TABLE "app_agent_inbound_grants" ADD CONSTRAINT "app_agent_inbound_grants_scopes_check" CHECK (
    cardinality("scopes") > 0
    AND "scopes" <@ ARRAY['agent:event:write', 'agent:notification:write']
);

ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_status_check" CHECK (
    "status" IN ('pending', 'approved', 'denied')
);

ALTER TABLE "app_agent_inbound_requests" ADD CONSTRAINT "app_agent_inbound_requests_scopes_check" CHECK (
    cardinality("scopes") > 0
    AND "scopes" <@ ARRAY['agent:event:write', 'agent:notification:write']
);

ALTER TABLE "app_agent_events" ADD CONSTRAINT "app_agent_events_kind_check" CHECK (
    "kind" IN ('event', 'notification')
);

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "kind" TEXT;
ALTER TABLE "agent_message_deliveries" ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK (
    "kind" IS NULL OR "kind" IN ('app_events')
);
