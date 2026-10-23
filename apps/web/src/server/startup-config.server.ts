import { readRetainedCloudImageIds } from "#src/server/hosts/cloud-image-inventory.server";
import {
  readAppWebhookConfiguration,
  rememberAppWebhookKey,
} from "#src/server/app-notifications/webhook-secret.server";
import {
  readAuthorizationServerConfiguration,
  rememberAuthorizationServerConfiguration,
} from "#src/server/authorization-server/configuration.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import {
  readFileDeliveryConfig,
  rememberFileDeliveryConfig,
} from "#src/server/files/file-delivery.server";
import { readPublicImageDeliveryConfig } from "#src/server/files/public-image-delivery.server";
import { readPublicImageStorageConfig } from "#src/server/files/public-image-storage.server";
import { readWeeklyReportScheduleTickMs } from "#src/server/records/weekly-report-schedule-tick.server";

/**
 * Deployment configuration that must be valid before the server accepts a single request.
 * The server entry calls this at module load, so a bad or unreadable value stops the process
 * during boot: the deployment's health check never passes, `remote-deploy.sh` keeps the previous
 * release, and no user request ever sees the error. Reading lazily on first use instead turns a
 * deployment mistake into request failures for whoever happens to hit that code path first.
 *
 * Optional features stay optional: an unset `COFORGE_FILE_DELIVERY_URL` is valid ("disabled"),
 * only a set URL with a missing or unreadable key is a boot failure. The same holds for public
 * profile-image delivery: unset is valid, but a deployment that publishes public image URLs
 * without the bucket that domain reads, or points them at the signed attachment domain, fails
 * here rather than serving broken avatars. The OIDC authorization server likewise: an unset
 * `COFORGE_OIDC_ISSUER` is valid; a set issuer that is not a usable URL, or comes without a
 * usable signing keyset, is a boot failure. Feature flags too: an unset
 * `COFORGE_FEATURE_FLAGS_FILE` leaves every flag off; a set path that is not a valid flag
 * definition file is a boot failure. App webhooks too: an unset `COFORGE_APP_WEBHOOK_KEY` leaves them
 * off; a set key shorter than 32 characters is a boot failure.
 */
export async function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await readStartupConfig(env);
  if (env === process.env) await installStartupConfig(config);
  console.info(JSON.stringify(startupConfigSummary(config)));
}

/** Validates the configuration in `env` and installs nothing, logs nothing: the boot-time check. */
export async function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await readStartupConfig(env);
}

async function readStartupConfig(env: NodeJS.ProcessEnv) {
  readRetainedCloudImageIds(env.COFORGE_RETAINED_CLOUD_IMAGE_IDS);
  const delivery = await readFileDeliveryConfig(env);
  const imageDelivery = readPublicImageDeliveryConfig(env);
  const imageStorage = await readPublicImageStorageConfig(env);
  const weeklyReportScheduleTickMs = readWeeklyReportScheduleTickMs(env);
  const authorizationServer = await readAuthorizationServerConfiguration(env);
  const featureFlags = await readFeatureFlagsConfiguration(env);
  const appWebhook = await readAppWebhookConfiguration(env);
  return {
    delivery,
    imageDelivery,
    imageStorage,
    weeklyReportScheduleTickMs,
    authorizationServer,
    featureFlags,
    appWebhook,
  };
}

async function installStartupConfig(config: Awaited<ReturnType<typeof readStartupConfig>>) {
  rememberFileDeliveryConfig(config.delivery);
  rememberAuthorizationServerConfiguration(config.authorizationServer);
  rememberAppWebhookKey(config.appWebhook.status === "ready" ? config.appWebhook.key : undefined);
  await installFeatureFlags(config.featureFlags);
}

function startupConfigSummary(config: Awaited<ReturnType<typeof readStartupConfig>>) {
  return {
    event: "startup_config_checked",
    file_delivery: config.delivery ? "configured" : "disabled",
    public_image_delivery: config.imageDelivery ? "configured" : "disabled",
    public_image_bucket: config.imageStorage ? "configured" : "shared",
    weekly_report_schedule_tick_ms: config.weeklyReportScheduleTickMs ?? null,
    authorization_server: config.authorizationServer.status === "ready" ? "configured" : "disabled",
    feature_flags: config.featureFlags.status,
    app_webhook: config.appWebhook.status === "ready" ? "configured" : "disabled",
  };
}
