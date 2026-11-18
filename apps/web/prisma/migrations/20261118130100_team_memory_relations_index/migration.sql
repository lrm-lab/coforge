CREATE INDEX CONCURRENTLY "team_memory_relations_idx"
  ON "team_memory_entries" USING GIN ("relations" jsonb_path_ops);
