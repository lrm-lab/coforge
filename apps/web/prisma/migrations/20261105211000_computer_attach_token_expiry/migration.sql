-- task #417: the attach_token's own ten minutes — minted at approval and single-use, its life
-- does not shrink to whatever the device session has left.
SET lock_timeout = '5s';
ALTER TABLE "computer_attach_sessions" ADD COLUMN "attach_token_expires_at" timestamp(3);
RESET lock_timeout;
