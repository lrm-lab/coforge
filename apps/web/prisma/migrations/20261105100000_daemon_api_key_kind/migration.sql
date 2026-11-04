-- task #417: `daemon_api_keys.kind` — `daemon` is the legacy `daemonApiKey`, `computer` the
-- `sk_computer` a swap-key issued. A new `NOT NULL` column needs no re-write with a `DEFAULT`;
-- `NOT VALID` CHECK skips the row scan, `VALIDATE CONSTRAINT` in a later release.
SET lock_timeout = '5s';
ALTER TABLE "daemon_api_keys"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'daemon',
  ADD CONSTRAINT "daemon_api_keys_kind_check" CHECK ("kind" IN ('daemon', 'computer')) NOT VALID;
RESET lock_timeout;
