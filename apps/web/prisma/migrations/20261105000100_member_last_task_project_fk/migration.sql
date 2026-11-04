-- NOT VALID so existing rows are not scanned under the constraint's table lock; the next
-- migration validates them.
SET lock_timeout = '5s';
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_last_task_project_id_fkey"
  FOREIGN KEY ("lastTaskProjectId") REFERENCES "projects"("id") ON DELETE SET NULL NOT VALID;
RESET lock_timeout;
