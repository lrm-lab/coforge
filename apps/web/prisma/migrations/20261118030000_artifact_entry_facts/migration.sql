-- What an artifact card says about a non-Markdown, non-HTML entry (PDF pages, text lines, CSV rows
-- and columns, image pixels, or size), kept from its current version. A nullable column, no
-- default, so no table rewrite; null until the next push or the entry-facts backfill.
-- Rollback: ALTER TABLE "artifacts" DROP COLUMN "entryFacts";
SET lock_timeout = '5s';
ALTER TABLE "artifacts" ADD COLUMN "entryFacts" JSONB;
RESET lock_timeout;
