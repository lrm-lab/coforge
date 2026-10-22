-- Image replace queues an "update" host job. The original check only listed
-- create, delete, and attach, so every upgrade insert was rejected.
ALTER TABLE "host_jobs" DROP CONSTRAINT "host_jobs_operation_check";

ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_operation_check" CHECK (
    "operation" IN ('create', 'delete', 'attach', 'update')
);
