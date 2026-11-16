-- migration-safety v1
-- checked: 2026-11-16T10:55:35.144Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: e5e7c02302d08757c3bc60bdb7519497c8202b59c05fe456947cec82b91f1e93
-- table: "app_installations" rows≈-1 size=98304 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
-- table: "app_installations" rows≈-1 size=98304 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP COLUMN
SET lock_timeout = '5s';
ALTER TABLE "app_installations" DROP CONSTRAINT "app_installations_agent_access_check", DROP COLUMN "agentAccess";
RESET lock_timeout;
