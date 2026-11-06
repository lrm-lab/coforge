-- migration-safety v1
-- checked: 2026-11-06T03:39:25.609Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-05T15:08:17.792Z production
-- body-sha256: ccd01d98cff9bb068e420ff853e0aa16a78f1e40fc353e44b48630ee71d3eab6
-- table: "message_forwards" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- table: "message_forwards" rows≈-1 size=0 lock=access-exclusive rewrite=yes statement=ALTER TABLE ADD PRIMARY KEY
-- A message's forward rows are keyed by (messageId, position): the index the previous migration
-- built becomes the primary key, so nothing is scanned or built under the lock.
-- Rollback: ALTER TABLE "message_forwards" DROP CONSTRAINT "message_forwards_pkey",
--   ADD CONSTRAINT "message_forwards_pkey" PRIMARY KEY ("messageId");
SET lock_timeout = '5s';
ALTER TABLE "message_forwards"
  DROP CONSTRAINT "message_forwards_pkey",
  ADD CONSTRAINT "message_forwards_pkey" PRIMARY KEY USING INDEX "message_forwards_messageId_position_key";
RESET lock_timeout;
