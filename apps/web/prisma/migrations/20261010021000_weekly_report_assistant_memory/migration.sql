-- Per-user weekly-report memory: writing habits and open work threads.
ALTER TABLE "weekly_report_assistants" ADD COLUMN "memory" JSONB;
