SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "task_dependencies" (
    "taskId" UUID NOT NULL,
    "blockedByTaskId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "creatorMemberId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("taskId","blockedByTaskId")
);

-- CreateTable
CREATE TABLE "task_parents" (
    "taskId" UUID NOT NULL,
    "parentTaskId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_parents_pkey" PRIMARY KEY ("taskId")
);

-- CreateIndex
CREATE INDEX "task_dependencies_blockedByTaskId_idx" ON "task_dependencies"("blockedByTaskId");

-- CreateIndex
CREATE INDEX "task_dependencies_workspaceId_idx" ON "task_dependencies"("workspaceId");

-- CreateIndex
CREATE INDEX "task_parents_parentTaskId_idx" ON "task_parents"("parentTaskId");

-- CreateIndex
CREATE INDEX "task_parents_workspaceId_idx" ON "task_parents"("workspaceId");

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blockedByTaskId_fkey" FOREIGN KEY ("blockedByTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_parents" ADD CONSTRAINT "task_parents_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_parents" ADD CONSTRAINT "task_parents_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
