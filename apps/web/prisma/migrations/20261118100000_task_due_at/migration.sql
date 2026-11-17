-- migration-safety v1
-- checked: 2026-11-18T10:00:00.000Z  pg: 18.0  verdict: ok
-- task #13: optional due instant (`dueAt`, `dueHasTime`) on tasks and `task_due_reminders` claim
-- table. Nullable/constant-default add-columns on `tasks` do not rewrite the table.
SET lock_timeout = '5s';
ALTER TABLE "tasks" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "dueHasTime" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "task_due_reminders" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "occurrence" INTEGER NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_due_reminders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_due_reminders_taskId_dueAt_occurrence_key"
  ON "task_due_reminders" ("taskId", "dueAt", "occurrence");

ALTER TABLE "task_due_reminders"
  ADD CONSTRAINT "task_due_reminders_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
