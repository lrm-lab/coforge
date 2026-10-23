-- An app's signed webhook (app notifications' HTTP delivery) and how deliveries to each installation
-- are going. The signing secret is derived from a server key, never stored.
-- CreateTable
CREATE TABLE "app_webhooks" (
    "appId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "endpointUrl" TEXT,
    "secretGeneration" INTEGER NOT NULL DEFAULT 0,
    "previousSecretGeneration" INTEGER,
    "previousSecretValidUntil" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_webhooks_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "app_installation_webhook_statuses" (
    "installationId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_installation_webhook_statuses_pkey" PRIMARY KEY ("installationId")
);

-- AddForeignKey
ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installation_webhook_statuses" ADD CONSTRAINT "app_installation_webhook_statuses_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "app_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_enabled_endpoint_check" CHECK (
    "enabled" = ("endpointUrl" IS NOT NULL)
);

ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_endpoint_url_check" CHECK (
    "endpointUrl" IS NULL
    OR (
        char_length("endpointUrl") <= 2000
        AND position('#' IN "endpointUrl") = 0
        AND "endpointUrl" LIKE 'https://%'
    )
);

ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_generation_check" CHECK (
    "secretGeneration" >= 0
    AND "revision" >= 0
    AND ("enabled" = false OR "secretGeneration" >= 1)
);

ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_previous_secret_check" CHECK (
    ("previousSecretGeneration" IS NULL) = ("previousSecretValidUntil" IS NULL)
    AND (
        "previousSecretGeneration" IS NULL
        OR ("enabled" AND "previousSecretGeneration" >= 1 AND "previousSecretGeneration" < "secretGeneration")
    )
);

ALTER TABLE "app_installation_webhook_statuses" ADD CONSTRAINT "app_installation_webhook_statuses_check" CHECK (
    "revision" >= 0
    AND "consecutiveFailures" >= 0
    AND ("lastError" IS NULL OR char_length("lastError") <= 100)
    AND (
        "disabledReason" IS NULL
        OR "disabledReason" IN ('endpoint_rejected', 'retries_exhausted', 'payload_too_large', 'endpoint_invalid')
    )
    AND (("disabledReason" IS NULL) = ("disabledAt" IS NULL))
);
