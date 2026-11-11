-- The index the backfilled columns serve: a person's forwards in one Workspace, newest first.
-- The forward picker's "most forwarded" read walks it and stops after the window (task #78),
-- instead of scanning the Workspace's messages and checking each sender.
-- Rollback: DROP INDEX CONCURRENTLY "message_forwards_workspaceId_senderUserId_createdAt_idx";
CREATE INDEX CONCURRENTLY "message_forwards_workspaceId_senderUserId_createdAt_idx" ON "message_forwards" ("workspaceId", "senderUserId", "createdAt" DESC);
