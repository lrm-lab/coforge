CREATE INDEX CONCURRENTLY "team_memory_content_fingerprint_idx"
ON "team_memory_entries" (
  "workspace_id",
  (COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid)),
  "kind",
  "applicability",
  (md5(trim(regexp_replace(normalize("content", NFKC), '[[:space:]]+', ' ', 'g')))),
  "id"
)
WHERE "status" = 'active' AND NOT "pinned";
