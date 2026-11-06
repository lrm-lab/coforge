-- A forward carries several originals (a selection of messages): each snapshot row takes its place
-- among them, and each attachment copy names the original it copies. Existing forwards keep their
-- one row at position 0; a forward with one original owns all of its message's attachments, so
-- their copies need no position. Both columns are metadata-only (a constant default, a nullable
-- column): no rewrite, the lock held only to change the catalog.
-- Rollback: ALTER TABLE "attachments" DROP COLUMN "forwardPosition";
--   ALTER TABLE "message_forwards" DROP COLUMN "position"; (after the primary key is restored)
SET lock_timeout = '5s';
ALTER TABLE "message_forwards" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attachments" ADD COLUMN "forwardPosition" INTEGER;
RESET lock_timeout;
