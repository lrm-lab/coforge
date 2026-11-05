-- migration-safety v1
-- checked: 2026-11-05T14:41:36.026Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-05T13:26:30.052Z production
-- body-sha256: f67d5a2d9af6745564cbfa003547d84bb872a548de1dd38e286d96cbea82b864
-- table: "workspace_assistants" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "workspace_assistants" DROP COLUMN "displayName";

RESET lock_timeout;
