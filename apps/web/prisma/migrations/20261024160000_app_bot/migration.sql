-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "enableBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "app_installation_bots" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'granted',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "statusText" TEXT,
    "grantedByUserId" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_installation_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_bot_credentials" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "keyHash" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "app_bot_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_installation_bots_installationId_key" ON "app_installation_bots"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "app_installation_bots_agentId_key" ON "app_installation_bots"("agentId");

-- CreateIndex
CREATE INDEX "app_installation_bots_grantedByUserId_idx" ON "app_installation_bots"("grantedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_bot_credentials_keyHash_key" ON "app_bot_credentials"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "app_bot_credentials_one_live" ON "app_bot_credentials"("botId") WHERE ("revokedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "app_installation_bots" ADD CONSTRAINT "app_installation_bots_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "app_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installation_bots" ADD CONSTRAINT "app_installation_bots_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installation_bots" ADD CONSTRAINT "app_installation_bots_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_bot_credentials" ADD CONSTRAINT "app_bot_credentials_botId_fkey" FOREIGN KEY ("botId") REFERENCES "app_installation_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The grant is either on or off; a stored status line is never empty, and a revoked bot holds none.
ALTER TABLE "app_installation_bots" ADD CONSTRAINT "app_installation_bots_state_check" CHECK ("state" IN ('granted', 'revoked'));
ALTER TABLE "app_installation_bots" ADD CONSTRAINT "app_installation_bots_status_check" CHECK ("statusText" IS NULL OR ("state" = 'granted' AND length("statusText") > 0));
