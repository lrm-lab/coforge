-- CreateTable
CREATE TABLE "workspace_former_slugs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_former_slugs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_former_slugs_slug_key" ON "workspace_former_slugs"("slug");

-- CreateIndex
CREATE INDEX "workspace_former_slugs_workspaceId_idx" ON "workspace_former_slugs"("workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_former_slugs" ADD CONSTRAINT "workspace_former_slugs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
