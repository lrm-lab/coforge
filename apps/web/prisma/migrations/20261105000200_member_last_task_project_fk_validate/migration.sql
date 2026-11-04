-- VALIDATE scans the table under a lock that does not block writes.
SET lock_timeout = '5s';
ALTER TABLE "conversation_members" VALIDATE CONSTRAINT "conversation_members_last_task_project_id_fkey";
RESET lock_timeout;
