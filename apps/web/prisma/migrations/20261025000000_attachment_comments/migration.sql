-- CreateTable
CREATE TABLE "attachment_comment_threads" (
    "attachmentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_comment_threads_pkey" PRIMARY KEY ("attachmentId")
);

-- CreateTable
CREATE TABLE "attachment_comments" (
    "messageId" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "anchorType" TEXT,
    "anchorData" JSONB,

    CONSTRAINT "attachment_comments_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_comment_threads_conversationId_key" ON "attachment_comment_threads"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_comment_threads_attachmentId_workspaceId_key" ON "attachment_comment_threads"("attachmentId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_comment_threads_conversationId_workspaceId_key" ON "attachment_comment_threads"("conversationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_comment_threads_attachmentId_workspaceId_convers_key" ON "attachment_comment_threads"("attachmentId", "workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "attachment_comments_attachmentId_messageId_idx" ON "attachment_comments"("attachmentId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_comments_messageId_conversationId_key" ON "attachment_comments"("messageId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_id_workspaceId_key" ON "attachments"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "attachment_comment_threads" ADD CONSTRAINT "attachment_comment_threads_attachmentId_workspaceId_fkey" FOREIGN KEY ("attachmentId", "workspaceId") REFERENCES "attachments"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_comment_threads" ADD CONSTRAINT "attachment_comment_threads_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_attachmentId_workspaceId_conversationI_fkey" FOREIGN KEY ("attachmentId", "workspaceId", "conversationId") REFERENCES "attachment_comment_threads"("attachmentId", "workspaceId", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Whole-file comments have no anchor; positional anchors carry one bounded JSON object.
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_anchor_check" CHECK (
  ("anchorType" IS NULL AND "anchorData" IS NULL)
  OR (
    "anchorType" IS NOT NULL
    AND "anchorType" IN ('md-section', 'lines', 'csv-rows', 'html-region')
    AND "anchorData" IS NOT NULL
    AND jsonb_typeof("anchorData") = 'object'
    AND octet_length("anchorData"::text) <= 4096
  )
);

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_kind_check";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK (
  "kind" IS NULL OR "kind" IN ('app_events', 'attachment_comments')
);

-- A comment thread is neither a public channel nor a direct conversation.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_destination_check";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_destination_check" CHECK (
  CASE WHEN "kind" = 'attachment_comments'
    THEN "directKey" IS NULL AND "channelName" IS NULL
    ELSE ("directKey" IS NOT NULL) <> ("channelName" IS NOT NULL)
  END
);
