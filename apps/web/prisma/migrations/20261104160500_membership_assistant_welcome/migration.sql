SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "workspace_memberships" ADD COLUMN     "assistantWelcome" BOOLEAN NOT NULL DEFAULT true;

RESET lock_timeout;
