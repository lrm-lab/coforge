-- AlterTable
ALTER TABLE "chat_sections" ADD COLUMN     "sortMode" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "workspace_member_preferences" ADD COLUMN     "chatSectionOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];
