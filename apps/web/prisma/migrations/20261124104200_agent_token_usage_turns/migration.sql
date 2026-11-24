-- CreateTable
CREATE TABLE "agent_token_usage_turns" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "computer_id" UUID,
    "launch_id" TEXT NOT NULL,
    "session_id" TEXT,
    "turn_seq" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "uncached_input_tokens" BIGINT NOT NULL,
    "cache_read_tokens" BIGINT NOT NULL,
    "cache_write_tokens" BIGINT NOT NULL,
    "output_tokens" BIGINT NOT NULL,
    "reasoning_output_tokens" BIGINT,
    "context_used_tokens" INTEGER,
    "context_window_tokens" INTEGER,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_token_usage_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_token_usage_turns_workspace_id_agent_id_recorded_at_idx" ON "agent_token_usage_turns"("workspace_id", "agent_id", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_token_usage_turns_agent_id_launch_id_turn_seq_key" ON "agent_token_usage_turns"("agent_id", "launch_id", "turn_seq");

-- AddForeignKey
ALTER TABLE "agent_token_usage_turns" ADD CONSTRAINT "agent_token_usage_turns_agent_id_workspace_id_fkey" FOREIGN KEY ("agent_id", "workspace_id") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_token_usage_turns" ADD CONSTRAINT "agent_token_usage_turns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;