-- task #524: a member-less Workspace owner/admin may add a Task's blocker — `creatorMemberId`
-- is nullable beside the member-less `creatorUserId`, one of them always set (the CHECK in the
-- next migration). `creatorUserId` is a bare uuid, like `Task.deletedByUserId`.
SET lock_timeout = '5s';
ALTER TABLE "task_dependencies"
  ALTER COLUMN "creatorMemberId" DROP NOT NULL,
  ADD COLUMN "creatorUserId" uuid;
RESET lock_timeout;
