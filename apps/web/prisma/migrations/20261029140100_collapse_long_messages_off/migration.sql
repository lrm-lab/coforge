-- Long messages show in full unless a member turns folding on for a conversation, as on Raft
-- (`collapseLongMessages ?? false`; task #280).
--
-- Existing rows: a member who turned folding back on after turning it off is stored the same as
-- one who never touched it (no record of who set it), so every member's folding is turned off.
-- Safe to run again.
ALTER TABLE "conversation_members" ALTER COLUMN "collapseLongMessages" SET DEFAULT false;
UPDATE "conversation_members" SET "collapseLongMessages" = false WHERE "collapseLongMessages";
