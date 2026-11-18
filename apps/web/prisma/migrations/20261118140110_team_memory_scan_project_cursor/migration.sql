SET lock_timeout = '5s';
ALTER TABLE "team_memory_review_scans" ADD COLUMN "cursor_project_id" UUID;
RESET lock_timeout;
