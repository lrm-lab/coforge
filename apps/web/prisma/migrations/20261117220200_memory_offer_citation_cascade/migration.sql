-- migration-safety v1
-- checked: 2026-11-17T07:02:47.154Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-17T00:13:17.583Z production
-- body-sha256: c0c9deb8f854e965c773b8985007bed847cb8aa9d5fa8cd69fae24d45fb60e2c
-- table: "memory_offer_citations" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- table: "memory_offer_citations" rows≈-1 size=32768 lock=share-row-exclusive rewrite=yes statement=ALTER TABLE ADD FOREIGN KEY
SET lock_timeout = '5s';
ALTER TABLE "memory_offer_citations" DROP CONSTRAINT "memory_offer_citations_openviking_citation_fkey", ADD CONSTRAINT "memory_offer_citations_openviking_citation_fkey" FOREIGN KEY ("workspace_id", "openviking_citation_id") REFERENCES "openviking_citation_records"("workspace_id", "citation_id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
