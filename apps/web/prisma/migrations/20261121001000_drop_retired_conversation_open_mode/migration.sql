-- migration-safety v1
-- checked: 2026-11-21T00:11:08.502Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-20T17:24:35.527Z production
-- body-sha256: 2ae82defe88c0963e5a6f6907bed3009336e5c73be018025256d8a3436cdafee
-- table: "user_preferences" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';
ALTER TABLE "user_preferences" DROP COLUMN "conversationOpenMode" RESTRICT;
RESET lock_timeout;
