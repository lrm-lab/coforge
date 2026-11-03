-- A person's account-wide notification settings (task #467). No row means the defaults.
-- CreateTable
CREATE TABLE "user_notification_settings" (
    "userId" UUID NOT NULL,
    "pausedUntil" TIMESTAMP(3),
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "quietEndMinute" INTEGER NOT NULL DEFAULT 480,
    "previewMode" TEXT NOT NULL DEFAULT 'full',
    "sound" BOOLEAN NOT NULL DEFAULT true,
    "mobileDelay" TEXT NOT NULL DEFAULT 'inactive',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_settings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
-- Takes SHARE ROW EXCLUSIVE on "users": bounded, so a long transaction cannot queue writes behind it.
SET lock_timeout = '5s';
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
RESET lock_timeout;
