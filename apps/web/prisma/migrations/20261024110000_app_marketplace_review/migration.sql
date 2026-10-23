-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "publishStatus" TEXT NOT NULL DEFAULT 'private',
ADD COLUMN     "publishedAt" TIMESTAMP(3);

ALTER TABLE "apps" ADD CONSTRAINT "apps_publish_status_check" CHECK (
    "publishStatus" IN ('private', 'publish_requested', 'published', 'rejected', 'unpublish_requested')
);

-- CreateTable
CREATE TABLE "platform_operators" (
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" UUID,

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "platform_operators_role_check" CHECK ("role" IN ('app_reviewer'))
);

-- CreateTable
CREATE TABLE "app_review_requests" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requestedByUserId" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "reason" TEXT,

    CONSTRAINT "app_review_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_review_requests_kind_check" CHECK ("kind" IN ('publish', 'unpublish')),
    CONSTRAINT "app_review_requests_decision_check" CHECK (
        ("outcome" IS NULL AND "decidedAt" IS NULL AND "reason" IS NULL)
        OR ("outcome" IN ('approved', 'rejected') AND "decidedAt" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "platform_operators_grantedByUserId_idx" ON "platform_operators"("grantedByUserId");

-- CreateIndex
CREATE INDEX "app_review_requests_requestedByUserId_idx" ON "app_review_requests"("requestedByUserId");

-- CreateIndex
CREATE INDEX "app_review_requests_decidedByUserId_idx" ON "app_review_requests"("decidedByUserId");

-- CreateIndex
CREATE INDEX "app_review_requests_requestedAt_idx" ON "app_review_requests"("requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_review_requests_one_pending" ON "app_review_requests"("appId") WHERE "outcome" IS NULL;

-- AddForeignKey
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_review_requests" ADD CONSTRAINT "app_review_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_review_requests" ADD CONSTRAINT "app_review_requests_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_review_requests" ADD CONSTRAINT "app_review_requests_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
