-- DropForeignKey
ALTER TABLE "host_nodes" DROP CONSTRAINT "host_nodes_registrar_user_id_fkey";

-- AlterTable
ALTER TABLE "computers" ADD COLUMN     "cloudSlot" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "host_nodes" DROP COLUMN "registrar_user_id",
ADD COLUMN     "accepting" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "host_jobs" ADD COLUMN     "operation" TEXT NOT NULL DEFAULT 'create';

-- CreateIndex
CREATE UNIQUE INDEX "computers_one_live_cloud_default" ON "computers"("ownerId") WHERE ("kind" = 'cloud' AND "cloudSlot" = 'default' AND "deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "computers_one_live_cloud_extra" ON "computers"("ownerId") WHERE ("kind" = 'cloud' AND "cloudSlot" = 'extra' AND "deletedAt" IS NULL);

-- Cloud Computers are default or extra. Local Computers have neither slot.
ALTER TABLE "computers" ADD CONSTRAINT "computers_cloud_slot_check" CHECK (
    ("kind" = 'cloud' AND "cloudSlot" IN ('default', 'extra'))
    OR ("kind" <> 'cloud' AND "cloudSlot" IS NULL)
);

ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_operation_check" CHECK (
    "operation" IN ('create', 'delete', 'attach')
);
