-- task #524: VALIDATE the CHECK `task_dependencies_creator_present` without holding the ADD's
-- lock — Prisma wraps one migration file in one transaction, so a same-file VALIDATE would scan
-- under the lock anyway. Existing rows pass (every `creatorMemberId` is set).
SET lock_timeout = '5s';
ALTER TABLE "task_dependencies" VALIDATE CONSTRAINT "task_dependencies_creator_present";
RESET lock_timeout;
