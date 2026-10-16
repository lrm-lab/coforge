-- CreateTable
CREATE TABLE "workspace_server_connections" (
    "workspaceId" UUID NOT NULL,
    "installOrigin" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "submittedByUserId" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_server_connections_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE INDEX "workspace_server_connections_submittedByUserId_idx" ON "workspace_server_connections"("submittedByUserId");

-- AddForeignKey
ALTER TABLE "workspace_server_connections" ADD CONSTRAINT "workspace_server_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_server_connections" ADD CONSTRAINT "workspace_server_connections_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
