SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "newAgentGreeting" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingAgentId" UUID,
ADD COLUMN     "onboardingMode" TEXT NOT NULL DEFAULT 'assistant';

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_onboardingAgentId_fkey" FOREIGN KEY ("onboardingAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_onboardingAgentId_fkey";

RESET lock_timeout;
