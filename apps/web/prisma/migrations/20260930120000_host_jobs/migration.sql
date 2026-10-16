-- CreateTable
CREATE TABLE "host_jobs" (
    "id" UUID NOT NULL,
    "host_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "workspace_slug" TEXT NOT NULL,
    "computer_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "daemon_api_key" TEXT,
    "container_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "reported_at" TIMESTAMP(3),

    CONSTRAINT "host_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "host_jobs_requested_by_user_id_idempotency_key_key" ON "host_jobs"("requested_by_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "host_jobs_host_id_reported_at_idx" ON "host_jobs"("host_id", "reported_at");

-- AddForeignKey
ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "host_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
