-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "appId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "nonce" TEXT,
    "scopes" TEXT[],
    "authTime" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "replayedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_app_consents" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_app_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_codeHash_key" ON "oauth_authorization_codes"("codeHash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_appId_idx" ON "oauth_authorization_codes"("appId");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_userId_idx" ON "oauth_authorization_codes"("userId");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_workspaceId_idx" ON "oauth_authorization_codes"("workspaceId");

-- CreateIndex
CREATE INDEX "user_app_consents_appId_idx" ON "user_app_consents"("appId");

-- CreateIndex
CREATE INDEX "user_app_consents_workspaceId_idx" ON "user_app_consents"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "user_app_consents_userId_appId_workspaceId_key" ON "user_app_consents"("userId", "appId", "workspaceId");

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
