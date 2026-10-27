-- A runtime upgrade queues a "runtime" host job. The previous check only
-- listed create, delete, attach, and update, so every runtime insert was rejected.
ALTER TABLE "host_jobs" DROP CONSTRAINT "host_jobs_operation_check";

ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_operation_check" CHECK (
    "operation" IN ('create', 'delete', 'attach', 'update', 'runtime')
);
