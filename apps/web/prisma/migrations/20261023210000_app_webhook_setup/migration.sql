-- A webhook may be switched on before it has an endpoint (Setup): enabled with a null endpoint.
-- An endpoint is still set only while enabled.
ALTER TABLE "app_webhooks" DROP CONSTRAINT "app_webhooks_enabled_endpoint_check";

ALTER TABLE "app_webhooks" ADD CONSTRAINT "app_webhooks_enabled_endpoint_check" CHECK (
    "enabled" OR "endpointUrl" IS NULL
);
