-- CreateTable
CREATE TABLE "apps" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerWorkspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "whenToUse" TEXT NOT NULL DEFAULT '',
    "homepageUrl" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "resourceUri" TEXT,
    "allowedScopes" TEXT[],
    "clientSecretHash" TEXT NOT NULL,
    "secretRotatedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_installations" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "installedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apps_key_key" ON "apps"("key");

-- CreateIndex
CREATE INDEX "apps_ownerWorkspaceId_idx" ON "apps"("ownerWorkspaceId");

-- CreateIndex
CREATE INDEX "apps_createdByUserId_idx" ON "apps"("createdByUserId");

-- CreateIndex
CREATE INDEX "app_installations_workspaceId_idx" ON "app_installations"("workspaceId");

-- CreateIndex
CREATE INDEX "app_installations_installedByUserId_idx" ON "app_installations"("installedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_installations_appId_workspaceId_key" ON "app_installations"("appId", "workspaceId");

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_installedByUserId_fkey" FOREIGN KEY ("installedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
