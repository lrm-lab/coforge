-- Which Agents may use an installed app: every Agent in the Workspace (`all`, the default), or only
-- those selected for the installation (`selected`). A CoForge extension beyond Raft.
-- AlterTable
ALTER TABLE "app_installations" ADD COLUMN     "agentAccess" TEXT NOT NULL DEFAULT 'all';

ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_agent_access_check" CHECK (
    "agentAccess" IN ('all', 'selected')
);

-- CreateTable
CREATE TABLE "app_installation_agents" (
    "installationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,

    CONSTRAINT "app_installation_agents_pkey" PRIMARY KEY ("installationId","agentId")
);

-- CreateIndex
CREATE INDEX "app_installation_agents_agentId_idx" ON "app_installation_agents"("agentId");

-- AddForeignKey
ALTER TABLE "app_installation_agents" ADD CONSTRAINT "app_installation_agents_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "app_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installation_agents" ADD CONSTRAINT "app_installation_agents_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
