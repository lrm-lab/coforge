-- DropForeignKey
ALTER TABLE "workspace_server_connections" DROP CONSTRAINT "workspace_server_connections_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "workspace_server_connections" DROP CONSTRAINT "workspace_server_connections_submittedByUserId_fkey";

-- DropTable
DROP TABLE "workspace_server_connections";
