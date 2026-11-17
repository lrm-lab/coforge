SET lock_timeout = '5s';
-- AlterTable
ALTER TABLE "team_memory_entries" ADD COLUMN     "author_user_id" UUID,
ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "project_id" UUID,
ALTER COLUMN "author_agent_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "team_memory_versions" ADD COLUMN     "actor_user_id" UUID,
ALTER COLUMN "actor_agent_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "team_memory_user_receipts" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "review_token" UUID,
    "review_revision" INTEGER NOT NULL DEFAULT 0,
    "review_expires_at" TIMESTAMP(3),
    "fingerprint" TEXT NOT NULL,
    "entry_id" UUID,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memory_user_receipts_pkey" PRIMARY KEY ("workspace_id","user_id","request_id")
);

-- CreateIndex
CREATE INDEX "team_memory_user_receipts_workspace_id_user_id_review_expir_idx" ON "team_memory_user_receipts"("workspace_id", "user_id", "review_expires_at");

-- AddForeignKey
ALTER TABLE "team_memory_user_receipts" ADD CONSTRAINT "team_memory_user_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
