-- External Agents: an Agent that runs on any machine and calls the Agent API with its own key.
-- Additive only: constant-default columns, a CHECK that starts NOT VALID (every existing row is
-- 'managed'), the per-machine credential table, and the device-code grant columns.
-- Rollback: DROP TABLE "external_agent_credentials"; drop the added columns and the CHECK.
SET lock_timeout = '5s';
ALTER TABLE "agents" ADD COLUMN "hosting" TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE "agents" ADD CONSTRAINT "agents_hosting_check"
  CHECK ("hosting" IN ('managed', 'external')) NOT VALID;
ALTER TABLE "device_authorizations"
  ADD COLUMN "client_id" TEXT NOT NULL DEFAULT 'coforge-computer',
  ADD COLUMN "grant" JSONB,
  ADD COLUMN "approved_agent_id" UUID,
  ADD COLUMN "approved_workspace_id" UUID;
CREATE TABLE "external_agent_credentials" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "approvedByUserId" UUID,
    "keyHash" TEXT NOT NULL,
    "machineName" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    CONSTRAINT "external_agent_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_agent_credentials_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "external_agent_credentials_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "external_agent_credentials_revokedReason_check" CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('logout', 'revoked', 'revoke_all', 'agent_deleted', 'agent_stopped'))
);
CREATE UNIQUE INDEX "external_agent_credentials_keyHash_key" ON "external_agent_credentials"("keyHash");
CREATE INDEX "external_agent_credentials_agentId_idx" ON "external_agent_credentials"("agentId");
RESET lock_timeout;
