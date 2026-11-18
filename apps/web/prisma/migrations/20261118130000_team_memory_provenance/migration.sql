SET lock_timeout = '5s';
ALTER TABLE "team_memory_entries"
  ADD COLUMN "evidence" JSONB,
  ADD COLUMN "relations" JSONB,
  ADD COLUMN "effective_at" TIMESTAMP(3);
RESET lock_timeout;
