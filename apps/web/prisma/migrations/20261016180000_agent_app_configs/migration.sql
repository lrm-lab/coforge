-- CreateTable
CREATE TABLE "agent_app_configs" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "appId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_app_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_app_configs_agentId_appId_key" ON "agent_app_configs"("agentId", "appId");

-- AddForeignKey
ALTER TABLE "agent_app_configs" ADD CONSTRAINT "agent_app_configs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
