-- message_forwards."workspaceId": the Workspace the carrying message belongs to. The forward
-- picker's "most forwarded" read counts a person's forwards per Workspace from one index
-- (task #78); the column is denormalized from the message, which the row cascades from.
-- Rollback: ALTER TABLE "message_forwards" DROP COLUMN "workspaceId";
SET lock_timeout = '5s';
ALTER TABLE "message_forwards" ADD COLUMN "workspaceId" UUID;
RESET lock_timeout;
