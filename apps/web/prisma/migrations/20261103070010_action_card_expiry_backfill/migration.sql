-- migration-safety v1
-- checked: 2026-11-03T07:22:37.878Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-03T03:32:05.486Z production
-- body-sha256: 90bc95b9553d39bf01ce9ff3b63e43c785ef68d777e49c9841121bc420f03d25
-- table: "action_cards" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
-- Cards already pending get a full window from this release, not from their creation: a backfill
-- from `createdAt` would expire a batch at once and wake every Agent that made one.
SET lock_timeout = '5s';
UPDATE "action_cards"
SET "expiresAt" = now() + interval '7 days'
WHERE "state" = 'pending' AND "expiresAt" IS NULL;
RESET lock_timeout;
