-- migration-safety v1
-- checked: 2026-11-16T10:55:35.224Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: f51afe6e2c9b2e3bc99246d61ab1a9bc3ccae2bd1ea18b9ae18b0c528883f8b1
-- table: "app_installation_agents" rows≈-1 size=16384 lock=access-exclusive rewrite=no statement=DROP TABLE
SET lock_timeout = '5s';
DROP TABLE "app_installation_agents";
RESET lock_timeout;
