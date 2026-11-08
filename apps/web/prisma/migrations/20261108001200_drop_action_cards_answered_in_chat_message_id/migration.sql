-- migration-safety v1
-- checked: 2026-11-08T03:25:39.605Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-08T02:28:03.814Z production
-- body-sha256: dd2f06bef40d8eebfad42e7ff3d64889c914013b3beefa31c4838bcb80067573
-- table: "action_cards" rows≈27 size=139264 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';

ALTER TABLE "action_cards" DROP COLUMN "answeredInChatMessageId";

RESET lock_timeout;
