-- task #493: the "What's new" card. The ids of the entries a person dismissed; NULL until the
-- first. A nullable column without a default: no rewrite, a brief lock only.
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" ADD COLUMN "whatsNewDismissed" TEXT[];
RESET lock_timeout;
