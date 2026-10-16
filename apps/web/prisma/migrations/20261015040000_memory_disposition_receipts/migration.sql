-- CreateTable
CREATE TABLE "memory_hint_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "target_agent_id" UUID NOT NULL,
    "memory_agent_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "body_hash" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "ttl_milliseconds" INTEGER NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "message_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_hint_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_disposition_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "hint_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "target_agent_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "intended_action_refs" TEXT[],
    "skipped_source_refs" TEXT[],
    "decided_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_disposition_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_disposition_citations" (
    "id" UUID NOT NULL,
    "disposition_id" UUID NOT NULL,
    "citation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" JSONB NOT NULL,

    CONSTRAINT "memory_disposition_citations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_hint_records_message_id_key" ON "memory_hint_records"("message_id");

-- CreateIndex
CREATE INDEX "memory_hint_records_workspace_id_target_agent_id_idx" ON "memory_hint_records"("workspace_id", "target_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_hint_records_workspace_id_operation_id_key" ON "memory_hint_records"("workspace_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_hint_records_workspace_id_id_key" ON "memory_hint_records"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_disposition_events_hint_id_sequence_key" ON "memory_disposition_events"("hint_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "memory_disposition_citations_disposition_id_citation_id_key" ON "memory_disposition_citations"("disposition_id", "citation_id");

-- AddForeignKey
ALTER TABLE "memory_hint_records" ADD CONSTRAINT "memory_hint_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_hint_records" ADD CONSTRAINT "memory_hint_records_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_disposition_events" ADD CONSTRAINT "memory_disposition_events_workspace_id_hint_id_fkey" FOREIGN KEY ("workspace_id", "hint_id") REFERENCES "memory_hint_records"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_disposition_citations" ADD CONSTRAINT "memory_disposition_citations_disposition_id_fkey" FOREIGN KEY ("disposition_id") REFERENCES "memory_disposition_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
