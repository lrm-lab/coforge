-- task #524: one of `creatorMemberId`/`creatorUserId` is always present — NOT VALID keeps the
-- row-scan off the lock; VALIDATE checks it separately. Rollback: drop the constraint, confirm
-- no `creatorMemberId IS NULL` row, ALTER COLUMN SET NOT NULL, DROP COLUMN "creatorUserId".
SET lock_timeout = '5s';
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_creator_present"
  CHECK ("creatorMemberId" IS NOT NULL OR "creatorUserId" IS NOT NULL) NOT VALID;
ALTER TABLE "task_dependencies" VALIDATE CONSTRAINT "task_dependencies_creator_present";
RESET lock_timeout;
