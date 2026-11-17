CREATE INDEX CONCURRENTLY IF NOT EXISTS "artifact_follows_userId_following_idx" ON "artifact_follows" ("userId") WHERE "following";
