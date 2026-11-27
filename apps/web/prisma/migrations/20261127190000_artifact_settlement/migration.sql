SET lock_timeout = '5s';

ALTER TABLE "artifacts"
ADD COLUMN "settledAt" TIMESTAMP(3),
ADD COLUMN "settledVersion" INTEGER,
ADD COLUMN "settledByKind" TEXT,
ADD COLUMN "settledById" UUID,
ADD COLUMN "reopenedAtVersion" INTEGER;

ALTER TABLE "artifact_read_positions"
ADD COLUMN "seenSettledAt" TIMESTAMP(3);

RESET lock_timeout;
