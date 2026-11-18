SET lock_timeout = '5s';
ALTER TABLE "team_memory_suggestions" ADD COLUMN "scan_id" UUID;
RESET lock_timeout;
