-- migration-safety v1
-- checked: 2026-11-04T10:00:00.000Z  pg: 18.0  verdict: ok
-- task #512: a deleted task keeps a soft marker for the undo window before the sweep removes
-- it, and the deleter a member-less admin cannot name. Nullable add-columns on the big table:
-- no rewrite.
SET lock_timeout = '5s';
ALTER TABLE "tasks" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "deletedByMemberId" UUID;
ALTER TABLE "tasks" ADD COLUMN "deletedByUserId" UUID;
RESET lock_timeout;
