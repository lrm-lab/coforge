-- Where an app is set up after it is installed, and which setup each installation finished.
-- An installation completes a revision of the app's setup; a new installation has completed none.
ALTER TABLE "app_installations" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "setupCompletedRevision" INTEGER;

ALTER TABLE "apps" ADD COLUMN     "setupDescription" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "setupRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "setupUrl" TEXT;

ALTER TABLE "apps" ADD CONSTRAINT "apps_setup_url_check" CHECK (
    "setupUrl" IS NULL
    OR (
        char_length("setupUrl") <= 2000
        AND position('#' IN "setupUrl") = 0
        AND (
            "setupUrl" LIKE 'https://%'
            OR "setupUrl" ~ '^http://(localhost|127\.0\.0\.1|\[::1\])([:/?]|$)'
        )
    )
);

ALTER TABLE "apps" ADD CONSTRAINT "apps_setup_description_check" CHECK (
    char_length("setupDescription") <= 500
);

ALTER TABLE "apps" ADD CONSTRAINT "apps_setup_revision_check" CHECK ("setupRevision" >= 0);

ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_setup_completion_check" CHECK (
    ("setupCompletedRevision" IS NULL) = ("setupCompletedAt" IS NULL)
    AND ("setupCompletedRevision" IS NULL OR "setupCompletedRevision" >= 0)
);
