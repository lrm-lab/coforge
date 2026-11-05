SET lock_timeout = '5s';

DROP INDEX "tasks_creatorMemberId_idx";

RESET lock_timeout;
