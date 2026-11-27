-- One Artifact pinned to the top of a channel or direct conversation. A new table whose only tie
-- to an existing table is its foreign key to `conversations`, guarded by a 5s lock timeout.
-- Rollback: DROP TABLE "conversation_pinned_artifacts";
SET lock_timeout = '5s';
CREATE TABLE "conversation_pinned_artifacts" (
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "pinnedByUserId" UUID,
    "pinnedByAgentId" UUID,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_pinned_artifacts_pkey" PRIMARY KEY ("conversationId"),
    CONSTRAINT "conversation_pinned_artifacts_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "conversation_pinned_artifacts_conversationId_workspaceId_key" ON "conversation_pinned_artifacts"("conversationId", "workspaceId");
CREATE INDEX "conversation_pinned_artifacts_workspaceId_idx" ON "conversation_pinned_artifacts"("workspaceId");
CREATE INDEX "conversation_pinned_artifacts_artifactId_idx" ON "conversation_pinned_artifacts"("artifactId");
RESET lock_timeout;
