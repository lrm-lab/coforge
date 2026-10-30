-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';

-- Only a channel can be private; every existing conversation stays public.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_visibility_check" CHECK (
  "visibility" = 'public' OR ("visibility" = 'private' AND "channelName" IS NOT NULL)
);
