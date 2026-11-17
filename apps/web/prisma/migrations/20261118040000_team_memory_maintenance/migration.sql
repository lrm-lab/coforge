SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "team_memory_maintenance" (
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "project_id" UUID,
    "suggested_at" TIMESTAMP(3) NOT NULL,
    "token" UUID,
    "expires_at" TIMESTAMP(3),
    "remaining" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "team_memory_maintenance_pkey" PRIMARY KEY ("workspace_id")
);

-- AddForeignKey
ALTER TABLE "team_memory_maintenance" ADD CONSTRAINT "team_memory_maintenance_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
