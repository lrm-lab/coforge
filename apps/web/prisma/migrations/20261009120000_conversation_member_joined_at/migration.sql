-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DataMigration: an approximation, since the first join time was never stored. A member's earliest
-- message stands for when they joined, so the value is later than the true join (they joined before
-- they sent it). A member who never sent one takes the conversation's creation time, so the value is
-- earlier than the true join when they joined after the conversation was created.
UPDATE "conversation_members" cm
   SET "joinedAt" = COALESCE(
     (SELECT MIN(m."createdAt") FROM "messages" m WHERE m."senderMemberId" = cm."id"),
     (SELECT c."createdAt" FROM "conversations" c WHERE c."id" = cm."conversationId")
   );
