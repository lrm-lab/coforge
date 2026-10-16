-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "deletedByUserId" UUID;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
