-- AlterTable
ALTER TABLE "apps" ADD COLUMN "ownerAgentId" UUID;

-- CreateIndex
CREATE INDEX "apps_ownerAgentId_idx" ON "apps"("ownerAgentId");

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_ownerAgentId_fkey" FOREIGN KEY ("ownerAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
