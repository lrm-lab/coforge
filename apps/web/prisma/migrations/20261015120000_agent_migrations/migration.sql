-- CreateTable
CREATE TABLE "agent_migrations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "sourceComputerId" UUID NOT NULL,
    "targetComputerId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "switchedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "agent_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_migrations_sourceComputerId_idx" ON "agent_migrations"("sourceComputerId");

-- CreateIndex
CREATE INDEX "agent_migrations_targetComputerId_idx" ON "agent_migrations"("targetComputerId");

-- CreateIndex
CREATE INDEX "agent_migrations_workspaceId_idx" ON "agent_migrations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_migrations_one_active" ON "agent_migrations"("agentId") WHERE ("state" <> 'completed' AND "state" <> 'canceled' AND "state" <> 'failed');

-- AddForeignKey
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_sourceComputerId_fkey" FOREIGN KEY ("sourceComputerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_targetComputerId_fkey" FOREIGN KEY ("targetComputerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
