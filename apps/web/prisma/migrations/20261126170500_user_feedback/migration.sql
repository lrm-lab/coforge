-- CreateTable
CREATE TABLE "user_feedback" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "workspaceId" UUID,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "pagePath" TEXT,
    "clientInfo" TEXT,
    "routedConversationId" UUID,
    "routedMessageId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_feedback_category_check" CHECK ("category" IN ('bug', 'idea', 'other')),
    CONSTRAINT "user_feedback_status_check" CHECK ("status" IN ('open', 'triaged', 'resolved', 'archived'))
);

-- CreateTable
CREATE TABLE "feedback_routing_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "conversationId" UUID,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_routing_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "feedback_routing_config_singleton_check" CHECK ("id" = 1)
);

-- CreateTable
CREATE TABLE "user_feedback_attachments" (
    "id" UUID NOT NULL,
    "feedbackId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feedback_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_feedback_status_createdAt_idx" ON "user_feedback"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "user_feedback_createdAt_idx" ON "user_feedback"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "user_feedback_userId_idx" ON "user_feedback"("userId");

-- CreateIndex
CREATE INDEX "user_feedback_workspaceId_idx" ON "user_feedback"("workspaceId");

-- CreateIndex
CREATE INDEX "user_feedback_routedConversationId_idx" ON "user_feedback"("routedConversationId");

-- CreateIndex
CREATE INDEX "feedback_routing_config_conversationId_idx" ON "feedback_routing_config"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_feedback_attachments_objectKey_key" ON "user_feedback_attachments"("objectKey");

-- CreateIndex
CREATE INDEX "user_feedback_attachments_feedbackId_idx" ON "user_feedback_attachments"("feedbackId");

-- AddForeignKey
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_routedConversationId_fkey" FOREIGN KEY ("routedConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_routing_config" ADD CONSTRAINT "feedback_routing_config_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedback_attachments" ADD CONSTRAINT "user_feedback_attachments_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "user_feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
