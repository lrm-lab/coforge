-- The data an app declares it reads where it is installed, and what each installation approved.
-- Groups are read-only: `workspace`, `agent`, `channel` and `computer`.
ALTER TABLE "app_installations" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" UUID,
ADD COLUMN     "approvedGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "approvedRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "apps" ADD COLUMN     "permissionGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "permissionRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "apps" ADD CONSTRAINT "apps_permission_groups_check" CHECK (
    "permissionGroups" IS NOT NULL
    AND "permissionGroups" <@ ARRAY['workspace', 'agent', 'channel', 'computer']::TEXT[]
);

ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_approved_groups_check" CHECK (
    "approvedGroups" IS NOT NULL
    AND "approvedGroups" <@ ARRAY['workspace', 'agent', 'channel', 'computer']::TEXT[]
);

-- CreateIndex
CREATE INDEX "app_installations_approvedByUserId_idx" ON "app_installations"("approvedByUserId");

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
