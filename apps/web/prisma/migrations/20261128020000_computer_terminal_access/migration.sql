SET lock_timeout = '5s';

ALTER TABLE "users" ADD COLUMN "web_login_generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "workspace_computers" ADD COLUMN "terminal_enabled" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
