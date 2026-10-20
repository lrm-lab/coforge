-- Every reaction write raises its message's `reactionVersion` in the same transaction, so of two
-- summaries of one message's reactions the page shows the one with the higher version. Existing
-- messages start at 0.

ALTER TABLE "messages" ADD COLUMN "reactionVersion" INTEGER NOT NULL DEFAULT 0;
