-- task #465: a sent or edited body's resolved references — `kind`, `targetId`, `raw`, `ordinal`.
-- New table; `CREATE INDEX` needs no lock. Rollback: drop the table.
SET lock_timeout = '5s';
CREATE TABLE "message_references" (
  "messageId" uuid NOT NULL,
  "conversationId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "kind" text NOT NULL,
  "targetId" uuid NOT NULL,
  "raw" text NOT NULL,
  "ordinal" integer NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_references_pkey" PRIMARY KEY ("messageId", "ordinal"),
  CONSTRAINT "message_references_kind_check"
    CHECK ("kind" IN ('task', 'channel', 'thread')),
  CONSTRAINT "message_references_messageId_conversationId_fkey"
    FOREIGN KEY ("messageId", "conversationId")
    REFERENCES "messages" ("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "message_references_targetId_idx" ON "message_references" ("targetId");
RESET lock_timeout;
