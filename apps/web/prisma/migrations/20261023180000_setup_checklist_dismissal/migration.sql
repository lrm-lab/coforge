-- AlterTable
ALTER TABLE "workspace_member_preferences" ADD COLUMN     "setupChecklistDismissedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "tasks_creatorMemberId_idx" ON "tasks"("creatorMemberId");
