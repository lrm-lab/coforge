-- migration-safety v1
-- checked: 2026-10-31T03:49:07.237Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-10-31T00:23:05.045Z production
-- body-sha256: b115bac0d8445a07ec9afb4ae16eaed7609495c1ccb64ced0dd94a9f35399bfa
-- table: "computers" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "computers" DROP COLUMN "lastRecovery";

RESET lock_timeout;
