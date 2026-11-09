-- task #743: `user_preferences.aiWorkbenchEnabled` — whether AI Workbench is on for the account.
-- NULL means off, so existing rows need no backfill. Nullable metadata-only column: no default, no
-- rewrite, the lock held only to change the catalog.
-- Rollback: ALTER TABLE "user_preferences" DROP COLUMN "aiWorkbenchEnabled";
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" ADD COLUMN "aiWorkbenchEnabled" BOOLEAN;
RESET lock_timeout;
