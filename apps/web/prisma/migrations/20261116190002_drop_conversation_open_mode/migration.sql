-- migration-safety v1
-- checked: 2026-11-16T10:55:35.261Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: 8ec9fdbe91ebe23c468870f853942df5877070f2bfcb3cbd597427a7cf8c29b6
-- table: "user_preferences" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- table: "user_preferences" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_conversationOpenMode_check", DROP COLUMN "conversationOpenMode";
RESET lock_timeout;
