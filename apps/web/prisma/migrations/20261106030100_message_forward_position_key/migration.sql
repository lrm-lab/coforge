-- The forward's new primary key, built first without blocking writes: the next migration makes it
-- the primary key in place. CREATE INDEX CONCURRENTLY cannot run in a transaction or beside
-- another statement, so it stands alone here with no lock_timeout wrapper.
-- Rollback: DROP INDEX CONCURRENTLY "message_forwards_messageId_position_key";
CREATE UNIQUE INDEX CONCURRENTLY "message_forwards_messageId_position_key"
  ON "message_forwards"("messageId", "position");
