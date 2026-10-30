-- What a Computer has left to run Agents with: the Agent data directory's filesystem and the
-- machine's memory, each as its daemon last reported. Null until a daemon that reports machine
-- status connects (older Computers send nothing, and the page shows "unknown").
ALTER TABLE "computers" ADD COLUMN "diskAvailableBytes" BIGINT;
ALTER TABLE "computers" ADD COLUMN "diskTotalBytes" BIGINT;
ALTER TABLE "computers" ADD COLUMN "diskReportedAt" TIMESTAMP(3);
ALTER TABLE "computers" ADD COLUMN "memoryAvailableBytes" BIGINT;
ALTER TABLE "computers" ADD COLUMN "memoryTotalBytes" BIGINT;
ALTER TABLE "computers" ADD COLUMN "memoryReportedAt" TIMESTAMP(3);
