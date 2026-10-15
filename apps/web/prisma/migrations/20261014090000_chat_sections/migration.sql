-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "chatSectionId" UUID;

-- CreateTable
CREATE TABLE "chat_sections" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sections_workspaceId_userId_createdAt_idx" ON "chat_sections"("workspaceId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_members_chatSectionId_idx" ON "conversation_members"("chatSectionId");

-- AddForeignKey
ALTER TABLE "chat_sections" ADD CONSTRAINT "chat_sections_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "workspace_memberships"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_chatSectionId_fkey" FOREIGN KEY ("chatSectionId") REFERENCES "chat_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
