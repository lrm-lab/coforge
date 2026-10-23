-- CreateTable
CREATE TABLE "app_share_links" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "app_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_share_links_tokenHash_key" ON "app_share_links"("tokenHash");

-- CreateIndex
CREATE INDEX "app_share_links_createdByUserId_idx" ON "app_share_links"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_share_links_one_active" ON "app_share_links"("appId") WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "app_share_links" ADD CONSTRAINT "app_share_links_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_share_links" ADD CONSTRAINT "app_share_links_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
