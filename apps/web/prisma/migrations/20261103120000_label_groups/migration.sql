-- CreateTable
CREATE TABLE "label_groups" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "selection" TEXT NOT NULL DEFAULT 'single',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "label_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_groups_workspaceId_idx" ON "label_groups"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "label_groups_workspaceId_nameKey_key" ON "label_groups"("workspaceId", "nameKey");

-- AddForeignKey
ALTER TABLE "label_groups" ADD CONSTRAINT "label_groups_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
