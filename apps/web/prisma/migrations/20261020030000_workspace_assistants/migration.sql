-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "systemKind" TEXT;

-- CreateTable
CREATE TABLE "workspace_assistants" (
    "workspaceId" UUID NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '通用助手',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_assistants_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "workspace_assistant_sessions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_assistant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_assistant_read_cursors" (
    "sessionId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "readThroughSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workspace_assistant_read_cursors_pkey" PRIMARY KEY ("sessionId","conversationId","scope")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_assistant_sessions_agentId_key" ON "workspace_assistant_sessions"("agentId");

-- CreateIndex
CREATE INDEX "workspace_assistant_sessions_userId_idx" ON "workspace_assistant_sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_assistant_sessions_workspaceId_userId_key" ON "workspace_assistant_sessions"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_assistant_sessions_agentId_workspaceId_key" ON "workspace_assistant_sessions"("agentId", "workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_assistants" ADD CONSTRAINT "workspace_assistants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_assistant_sessions" ADD CONSTRAINT "workspace_assistant_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace_assistants"("workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_assistant_sessions" ADD CONSTRAINT "workspace_assistant_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_assistant_sessions" ADD CONSTRAINT "workspace_assistant_sessions_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_assistant_read_cursors" ADD CONSTRAINT "workspace_assistant_read_cursors_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "workspace_assistant_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing Workspaces receive the same shared configuration as newly created ones.
INSERT INTO "workspace_assistants" ("workspaceId")
SELECT "id" FROM "workspaces"
ON CONFLICT ("workspaceId") DO NOTHING;
