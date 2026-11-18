-- migration-safety v1
-- checked: 2026-11-18T17:42:42.983Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-18T11:21:22.402Z production
-- body-sha256: f312c766fb5d9e9d6fe2f061d3ab8805838b4ef35acad94604949bbc494edb13
-- table: "artifacts" rows≈6 size=90112 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- task #artifacts:#27: `artifacts.access` gains the `link` tier (anyone with the address reads;
-- Workspace members and Agents read it as `workspace`). One ALTER swaps the CHECK so no write ever
-- meets a table without it; it only widens, is added NOT VALID, and is proven by the next migration.
-- Rollback: ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_access_check", ADD CONSTRAINT "artifacts_access_check" CHECK ("access" IN ('conversation', 'workspace')) NOT VALID; (no `link` row exists before migration B; after it, restore those rows from artifact_access_events first)
SET lock_timeout = '5s';
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_access_check", ADD CONSTRAINT "artifacts_access_check" CHECK ("access" IN ('conversation', 'workspace', 'link')) NOT VALID;
RESET lock_timeout;
