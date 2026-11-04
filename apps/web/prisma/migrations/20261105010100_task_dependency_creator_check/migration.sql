-- task #524: one of `creatorMemberId`/`creatorUserId` is always present — NOT VALID keeps the
-- row-scan off the lock; VALIDATE follows in its own migration. Rollback: drop the constraint,
-- confirm no `creatorMemberId IS NULL` row, ALTER COLUMN SET NOT NULL, DROP COLUMN.
SET lock_timeout = '5s';
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_creator_present"
  CHECK ("creatorMemberId" IS NOT NULL OR "creatorUserId" IS NOT NULL) NOT VALID;
RESET lock_timeout;
