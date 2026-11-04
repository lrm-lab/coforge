-- VALIDATE scans the table under a lock that does not block writes.
SET lock_timeout = '5s';
ALTER TABLE "conversation_members" VALIDATE CONSTRAINT "conversation_members_lastTaskProjectId_fkey";
RESET lock_timeout;
