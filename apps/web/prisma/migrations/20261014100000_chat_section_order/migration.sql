-- AlterTable
ALTER TABLE "chat_sections" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "chatSectionSortOrder" INTEGER NOT NULL DEFAULT 0;
