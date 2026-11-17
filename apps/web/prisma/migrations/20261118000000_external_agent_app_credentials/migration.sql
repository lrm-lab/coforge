-- migration-safety v1
-- checked: 2026-11-17T07:39:19.945Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-17T00:13:17.583Z production
-- body-sha256: 2eef77724410579b3e13df067e77464e4b335fda6d6f5323845fa1eed8645c60
-- table: "external_agent_credentials" rows≈0 size=0 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';
ALTER TABLE "external_agent_credentials"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'device',
  ALTER COLUMN "machineName" DROP NOT NULL,
  ALTER COLUMN "hostname" DROP NOT NULL,
  ALTER COLUMN "os" DROP NOT NULL,
  ALTER COLUMN "clientName" DROP NOT NULL,
  DROP CONSTRAINT "external_agent_credentials_revokedReason_check",
  ADD CONSTRAINT "external_agent_credentials_revokedReason_check" CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('logout', 'revoked', 'agent_deleted', 'agent_stopped', 'replaced')) NOT VALID,
  ADD CONSTRAINT "external_agent_credentials_source_check" CHECK ("source" IN ('device', 'app')) NOT VALID;
RESET lock_timeout;
