-- task #417 step 3: the one-shot Computer attach (device code -> web approval -> single-use
-- attachToken -> sk_computer) and the retired-login marker the verify path checks. Codes and
-- tokens live only as hashes; a session's status moves pending -> approved/refused -> consumed.
SET lock_timeout = '5s';
CREATE TABLE "computer_attach_sessions" (
  "id" uuid NOT NULL,
  "device_code_hash" text NOT NULL,
  "user_code" text NOT NULL,
  "machine_name" text NOT NULL,
  "hostname" text NOT NULL,
  "os" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attach_token_hash" text,
  "token_consumed_at" timestamp(3),
  "approved_user_id" uuid,
  "approved_workspace_id" uuid,
  "expires_at" timestamp(3) NOT NULL,
  "last_polled_at" timestamp(3),
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "computer_attach_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "computer_attach_sessions_device_code_hash_key" ON "computer_attach_sessions"("device_code_hash");
CREATE UNIQUE INDEX "computer_attach_sessions_attach_token_hash_key" ON "computer_attach_sessions"("attach_token_hash");
CREATE INDEX "computer_attach_sessions_expires_at_idx" ON "computer_attach_sessions"("expires_at");
CREATE INDEX "computer_attach_sessions_status_idx" ON "computer_attach_sessions"("status");
CREATE TABLE "computer_retired_logins" (
  "id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" uuid NOT NULL,
  "computer_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "retired_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "computer_retired_logins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "computer_retired_logins_token_hash_key" ON "computer_retired_logins"("token_hash");
RESET lock_timeout;
