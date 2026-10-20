-- An Agent's access to the apps installed in its Workspace: one grant per app and Agent (a revoked
-- one stays, so the Agent needs an approval again), and its requests for approval.
-- CreateTable
CREATE TABLE "app_agent_grants" (
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

    CONSTRAINT "app_agent_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_agent_access_requests" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" UUID,

    CONSTRAINT "app_agent_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_agent_grants_agentId_idx" ON "app_agent_grants"("agentId");

-- CreateIndex
CREATE INDEX "app_agent_grants_workspaceId_idx" ON "app_agent_grants"("workspaceId");

-- CreateIndex
CREATE INDEX "app_agent_grants_grantedByUserId_idx" ON "app_agent_grants"("grantedByUserId");

-- CreateIndex
CREATE INDEX "app_agent_grants_revokedByUserId_idx" ON "app_agent_grants"("revokedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_grants_appId_agentId_key" ON "app_agent_grants"("appId", "agentId");

-- CreateIndex
CREATE INDEX "app_agent_access_requests_agentId_createdAt_idx" ON "app_agent_access_requests"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "app_agent_access_requests_workspaceId_idx" ON "app_agent_access_requests"("workspaceId");

-- CreateIndex
CREATE INDEX "app_agent_access_requests_decidedByUserId_idx" ON "app_agent_access_requests"("decidedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_agent_access_requests_one_pending" ON "app_agent_access_requests"("appId", "agentId") WHERE ("status" = 'pending');

-- AddForeignKey
ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_access_requests" ADD CONSTRAINT "app_agent_access_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_access_requests" ADD CONSTRAINT "app_agent_access_requests_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_access_requests" ADD CONSTRAINT "app_agent_access_requests_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agent_access_requests" ADD CONSTRAINT "app_agent_access_requests_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "app_agent_grants" ADD CONSTRAINT "app_agent_grants_source_check" CHECK (
    "source" IN ('person', 'automatic', 'approval')
);

ALTER TABLE "app_agent_access_requests" ADD CONSTRAINT "app_agent_access_requests_status_check" CHECK (
    "status" IN ('pending', 'approved', 'denied')
);
