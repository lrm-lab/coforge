-- migration-safety v1
-- checked: 2026-11-12T11:45:51.325Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-12T09:00:16.753Z production
-- body-sha256: 0887aaac274f1e06986cca9ca64a01b160dc161fb5e42c04dc96ff46547dea39
-- table: "message_forwards" rows≈6 size=65536 lock=access-exclusive rewrite=yes statement=ALTER TABLE SET NOT NULL
-- task #93 release two: 20261112111400 backfills every NULL row from its source conversation
-- in the same deploy, so this holds in any environment; production's application backfill
-- already ran (6/6, 0 skipped). A row still NULL here has a deleted source conversation —
-- fill it by hand from its message, then resolve. Rollback:
-- ALTER TABLE "message_forwards" ALTER COLUMN "workspaceId" DROP NOT NULL;
SET lock_timeout = '5s';
ALTER TABLE "message_forwards" ALTER COLUMN "workspaceId" SET NOT NULL;
RESET lock_timeout;
