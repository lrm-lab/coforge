-- migration-safety v1
-- checked: 2026-11-06T20:19:47.663Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-06T17:40:08.153Z production
-- body-sha256: 5f5ea5157ee941aa8165e6a59ccd5f1caa52c05f1fd06e0936260c901bd58219
-- table: "conversations" rows≈448 size=311296 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_projectId_fkey";

RESET lock_timeout;
