-- Where an artifact saved from a message's attachment came from: two nullable columns with no
-- default, so no rewrite and no existing row changes.
-- Rollback: ALTER TABLE "artifacts" DROP COLUMN "originMessageId", DROP COLUMN "originAttachmentId";
SET lock_timeout = '5s';
ALTER TABLE "artifacts" ADD COLUMN "originMessageId" UUID, ADD COLUMN "originAttachmentId" UUID;
RESET lock_timeout;
