-- migration-safety v1
-- checked: 2026-11-08T03:25:39.605Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-08T02:28:03.814Z production
-- body-sha256: 2e0116e61bfb7f1529994697c4af500f9d17ff7a993975644bcaeb0bc7daf605
-- table: "action_cards" rows≈27 size=139264 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "action_cards" DROP COLUMN "answeredInChatAt";

RESET lock_timeout;
