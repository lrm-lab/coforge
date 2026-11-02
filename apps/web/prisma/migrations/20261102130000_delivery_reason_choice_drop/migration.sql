-- migration-safety v1
-- checked: 2026-11-02T09:26:23.751Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: 2ac02adc28abb60b0878c73435721b56d4d1850bc37d1b561b2a3b175f34dbd4
-- table: "agent_message_deliveries" rows≈-1 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';

ALTER TABLE "agent_message_deliveries" DROP CONSTRAINT "agent_message_deliveries_reason_check";

RESET lock_timeout;
