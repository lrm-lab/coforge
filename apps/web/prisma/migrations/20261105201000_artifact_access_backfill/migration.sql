-- migration-safety v1
-- checked: 2026-11-04T20:35:24.418Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-04T03:33:16.527Z production
-- body-sha256: 6c2c90a82ab95b45e1a14a8b56086243a8fcd9817135081024cf11767c31e92b
-- table: "artifacts" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
-- task #529: workspace-home artifacts keep the `workspace` tier — the only tier that home has.
-- `IS DISTINCT FROM` leaves already-correct rows alone.
SET lock_timeout = '5s';
UPDATE "artifacts" SET "access" = 'workspace'
  WHERE "homeKey" = 'workspace' AND "access" IS DISTINCT FROM 'workspace';
RESET lock_timeout;
