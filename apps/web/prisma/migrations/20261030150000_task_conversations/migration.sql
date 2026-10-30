-- A Task made under task conversations posts no message in its channel. It has a conversation of
-- its own (kind 'task_thread', made by the first reply), may name the message it was made from,
-- and is followed by members, not through a message.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_kind_check";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK (
  "kind" IS NULL OR "kind" IN ('app_events', 'attachment_comments', 'task_thread')
);

-- Like a comment thread, a task conversation is neither a channel nor a direct conversation.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_destination_check";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_destination_check" CHECK (
  CASE WHEN "kind" IN ('attachment_comments', 'task_thread')
    THEN "directKey" IS NULL AND "channelName" IS NULL
    ELSE ("directKey" IS NOT NULL) <> ("channelName" IS NOT NULL)
  END
);

ALTER TABLE "tasks" ADD COLUMN "sourceMessageId" UUID;
ALTER TABLE "tasks" ADD COLUMN "discussionConversationId" UUID;
CREATE UNIQUE INDEX "tasks_discussionConversationId_key" ON "tasks"("discussionConversationId");
CREATE INDEX "tasks_sourceMessageId_status_idx" ON "tasks"("sourceMessageId", "status");
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_sourceMessageId_fkey"
  FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_discussionConversationId_fkey"
  FOREIGN KEY ("discussionConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "task_follows" (
  "taskId" UUID NOT NULL,
  "memberId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_follows_pkey" PRIMARY KEY ("memberId", "taskId"),
  CONSTRAINT "task_follows_reason_check" CHECK ("reason" IN ('created', 'claimed', 'assigned', 'replied', 'mentioned', 'manual'))
);
CREATE INDEX "task_follows_taskId_idx" ON "task_follows"("taskId");
ALTER TABLE "task_follows"
  ADD CONSTRAINT "task_follows_taskId_conversationId_fkey"
  FOREIGN KEY ("taskId", "conversationId") REFERENCES "tasks"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_follows"
  ADD CONSTRAINT "task_follows_memberId_conversationId_workspaceId_fkey"
  FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
