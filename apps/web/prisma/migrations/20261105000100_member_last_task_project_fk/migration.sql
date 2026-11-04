-- NOT VALID so existing rows are not scanned under the constraint's table lock; the next
-- migration validates them.
SET lock_timeout = '5s';
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_lastTaskProjectId_fkey"
  FOREIGN KEY ("lastTaskProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
RESET lock_timeout;
