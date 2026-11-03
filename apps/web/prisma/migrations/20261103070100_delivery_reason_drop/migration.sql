-- migration-safety v1
-- checked: 2026-11-03T07:22:37.910Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-03T03:32:05.486Z production
-- body-sha256: 9ff26ba822b9e80ac97d075c9021a1c1faf1937291b075c658d0871673815c49
-- table: "agent_message_deliveries" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';
ALTER TABLE "agent_message_deliveries" DROP CONSTRAINT "agent_message_deliveries_reason_check";
RESET lock_timeout;
