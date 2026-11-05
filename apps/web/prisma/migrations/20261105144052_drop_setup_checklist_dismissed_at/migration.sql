-- migration-safety v1
-- checked: 2026-11-05T14:41:36.062Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-05T13:26:30.052Z production
-- body-sha256: 8c1dd9c238f046a4bcf5548648bada84c81ed59e608bbdead4b3fb03d44f4418
-- table: "workspace_member_preferences" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "workspace_member_preferences" DROP COLUMN "setupChecklistDismissedAt";

RESET lock_timeout;
