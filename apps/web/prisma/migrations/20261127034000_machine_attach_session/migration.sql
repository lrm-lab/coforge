SET lock_timeout = '5s';
ALTER TABLE "computer_attach_sessions"
  ADD COLUMN "protocol_major" INTEGER,
  ADD COLUMN "attach_intent" TEXT,
  ADD COLUMN "machine_public_key" BYTEA,
  ADD COLUMN "machine_id" TEXT,
  ADD COLUMN "computer_version" TEXT,
  ADD COLUMN "os_version" TEXT,
  ADD COLUMN "target_workspace_id" UUID,
  ADD COLUMN "existing_computer_id" UUID,
  ADD COLUMN "candidate_computer_id" UUID,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "bound_at" TIMESTAMP(3),
  ADD COLUMN "ready_at" TIMESTAMP(3),
  ADD COLUMN "terminal_at" TIMESTAMP(3),
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "nonce_hash" TEXT,
  ADD COLUMN "nonce_expires_at" TIMESTAMP(3),
  ADD COLUMN "candidate_key_hash" TEXT,
  ADD COLUMN "activated_key_hash" TEXT;
ALTER TABLE "workspace_computers" ADD COLUMN "attach_machine_public_key" BYTEA;
RESET lock_timeout;
