SET lock_timeout = '5s';
ALTER TABLE "agents" ADD COLUMN "externalStatusReportedAt" TIMESTAMP(3);
ALTER TABLE "agent_activities" ALTER COLUMN "computerId" DROP NOT NULL;
RESET lock_timeout;
