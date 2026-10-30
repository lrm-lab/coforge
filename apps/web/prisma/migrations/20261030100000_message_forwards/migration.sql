-- CreateTable
CREATE TABLE "message_forwards" (
    "messageId" UUID NOT NULL,
    "sourceMessageId" UUID,
    "sourceConversationId" UUID NOT NULL,
    "sourceThreadRootId" UUID,
    "sourceConversationName" TEXT,
    "sourceSenderName" TEXT NOT NULL,
    "sourceSenderHandle" TEXT NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "sourceBody" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_forwards_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "message_forwards_sourceMessageId_idx" ON "message_forwards"("sourceMessageId");

-- AddForeignKey
ALTER TABLE "message_forwards" ADD CONSTRAINT "message_forwards_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_forwards" ADD CONSTRAINT "message_forwards_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
