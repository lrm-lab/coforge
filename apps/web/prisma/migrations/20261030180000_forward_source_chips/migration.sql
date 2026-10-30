-- The forwarded card's chips: the original's body as stored and its mentions, beside the plain-text
-- snapshot every other surface keeps reading. Both stay null on a forward made before this.
SET lock_timeout = '5s';
ALTER TABLE "message_forwards" ADD COLUMN "sourceRawBody" TEXT, ADD COLUMN "sourceMentions" JSONB;
RESET lock_timeout;
