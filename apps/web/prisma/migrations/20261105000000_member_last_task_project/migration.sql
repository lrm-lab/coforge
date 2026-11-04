-- task #484: a member row remembers the Project the member last used on a Task in that
-- conversation, so the Task form can offer it as the default.
SET lock_timeout = '5s';
ALTER TABLE "conversation_members" ADD COLUMN "lastTaskProjectId" UUID;
RESET lock_timeout;
