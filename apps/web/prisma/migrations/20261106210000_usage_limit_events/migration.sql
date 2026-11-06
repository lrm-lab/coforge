-- CreateTable
CREATE TABLE "usage_limit_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resetsAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "usage_limit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_limit_event_agents" (
    "eventId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_limit_event_agents_pkey" PRIMARY KEY ("eventId","agentId")
);

-- CreateTable
CREATE TABLE "usage_limit_event_views" (
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seenAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "usage_limit_event_views_pkey" PRIMARY KEY ("eventId","userId")
);

-- CreateIndex
CREATE INDEX "usage_limit_events_workspaceId_status_idx" ON "usage_limit_events"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "usage_limit_events_one_open" ON "usage_limit_events"("workspaceId", "computerId", "provider") WHERE ("status" = 'open');

-- CreateIndex
CREATE INDEX "usage_limit_event_agents_agentId_idx" ON "usage_limit_event_agents"("agentId");

-- AddForeignKey
ALTER TABLE "usage_limit_events" ADD CONSTRAINT "usage_limit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_limit_events" ADD CONSTRAINT "usage_limit_events_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_limit_event_agents" ADD CONSTRAINT "usage_limit_event_agents_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "usage_limit_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_limit_event_agents" ADD CONSTRAINT "usage_limit_event_agents_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_limit_event_views" ADD CONSTRAINT "usage_limit_event_views_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "usage_limit_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_limit_event_views" ADD CONSTRAINT "usage_limit_event_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
