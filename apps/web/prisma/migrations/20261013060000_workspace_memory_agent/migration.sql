-- One live Memory Agent identity per Workspace. Soft-delete removes this row in
-- application code; the Agent row itself stays so channel history remains readable.

CREATE TABLE "workspace_memory_agents" (
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_memory_agents_pkey" PRIMARY KEY ("workspace_id")
);

CREATE UNIQUE INDEX "workspace_memory_agents_agent_id_key" ON "workspace_memory_agents"("agent_id");

ALTER TABLE "workspace_memory_agents" ADD CONSTRAINT "workspace_memory_agents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_memory_agents" ADD CONSTRAINT "workspace_memory_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
