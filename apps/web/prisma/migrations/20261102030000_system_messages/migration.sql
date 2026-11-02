SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "system_messages" (
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_messages_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_messages_messageId_conversationId_key" ON "system_messages"("messageId", "conversationId");

-- CreateIndex
CREATE INDEX "system_messages_conversationId_workspaceId_idx" ON "system_messages"("conversationId", "workspaceId");

-- AddForeignKey
ALTER TABLE "system_messages" ADD CONSTRAINT "system_messages_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_messages" ADD CONSTRAINT "system_messages_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
