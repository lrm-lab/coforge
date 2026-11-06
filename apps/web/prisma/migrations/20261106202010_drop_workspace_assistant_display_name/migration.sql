-- migration-safety v1
-- checked: 2026-11-06T20:19:47.663Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-06T17:40:08.153Z production
-- body-sha256: f67d5a2d9af6745564cbfa003547d84bb872a548de1dd38e286d96cbea82b864
-- table: "workspace_assistants" rows≈11 size=65536 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "workspace_assistants" DROP COLUMN "displayName";

RESET lock_timeout;
