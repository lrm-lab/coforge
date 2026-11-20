import handler from "@tanstack/react-start/server-entry";

import { isRawHttpPath } from "#src/lib/non-localized-path";
import { paraglideMiddleware } from "#src/paraglide/server";
import {
  channelThreadUnreadQueueReady,
  startAppNotificationQueueAtServerStartFromEnv,
} from "#src/server/app-notifications/app-notification-queue.server";
import { registerArtifactCheckJobRunner } from "#src/server/artifacts/artifact-check-queue.server";
import { productionArtifactChecks } from "#src/server/artifacts/artifact-composition.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { publicOrigin } from "#src/server/http/public-origin.server";
import { textResponse } from "#src/server/http/text-response.server";
import {
  artifactSandboxOrigin,
  isSandboxRequest,
} from "#src/server/artifacts/artifact-sandbox-config.server";
import { serveArtifactSandbox } from "#src/server/artifacts/artifact-sandbox-http.server";
import { installServerLifecycle } from "#src/server/runtime/server-lifecycle.server";
import { assertStartupConfig } from "#src/server/startup-config.server";
import { startWeeklyReportScheduleTickFromEnv } from "#src/server/records/weekly-report-schedule-tick.server";
import { startActionCardExpiryTickFromEnv } from "#src/server/conversations/action-card-expiry.server";
import { startMessageReadRetentionTickFromEnv } from "#src/server/conversations/message-read-retention.server";
import { startWorkspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import { startPlatformOperatorSeedingFromEnv } from "#src/server/app-marketplace/platform-operator-seeding.server";
import { ensureReminderDueSweep } from "#src/server/reminders/reminder-due-sweep.server";
import { ensureTaskDueSweep } from "#src/server/tasks/task-due-sweep.server";

// This module loads on the first request (Nitro loads the SSR entry lazily), not at boot. It
// validates and installs the configuration the request handlers read, so a request never runs
// without it. The boot-time check that fails the deployment is `runtime/boot-config-check.server.ts`
// (a Nitro plugin, registered in `vite.config.ts`).
await assertStartupConfig();
installServerLifecycle();
ensureReminderDueSweep();
ensureTaskDueSweep();
// Backend-owned memory sweep: independent of incidental Centrifugo traffic.
// Optional in-process clock for weekly-report auto-send. No-op unless
// COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS is set; external HTTP cron remains valid.
startWeeklyReportScheduleTickFromEnv();
// Cards expire after their TTL; the atomic sweep keeps every instance from announcing twice.
startActionCardExpiryTickFromEnv();
// Read records older than a week are pruned daily; deleting one only drops a "read at" time.
startMessageReadRetentionTickFromEnv();
startWorkspaceAssistantOnboarding();
// The first Marketplace operators, from the deployment's config; only when none exists yet.
startPlatformOperatorSeedingFromEnv();
registerArtifactCheckJobRunner((job, options) =>
  productionArtifactChecks(requireDatabaseClient()).runJob(job, options),
);
// The app notification outbox's pg-boss workers run in the process that serves requests. This
// entry loads on the first request, which the deployment's health check makes at start.
startAppNotificationQueueAtServerStartFromEnv();

/** Requests Paraglide never sees: raw HTTP without a locale prefix. The unprefixed pages go
 * through it to render in the visitor's locale, without a redirect. */
export function isNonLocalizedRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    isRawHttpPath(pathname) ||
    // The two bootstrap installer entry points (`curl .../computer/install.sh | sh`,
    // `irm .../computer/install.ps1 | iex`) must resolve at exactly this path in every
    // environment (docs/release/local-feed-hosting.md). Paraglide's
    // URL-pattern middleware otherwise 307-redirects any unprefixed path to `/en/...`, which
    // both breaks the documented URL and turns a `curl | sh` pipeline's error case into an
    // 18 KB HTML not-found page instead of plain text.
    pathname === "/computer/install.sh" ||
    pathname === "/computer/install.ps1" ||
    pathname === "/cli/install.sh" ||
    pathname === "/cli/install.ps1"
  );
}

/** The URL the browser actually requested, for Paraglide's route matching and locale redirect.
 * Behind the TLS-terminating proxy `request.url` is `http://`, and Paraglide builds its redirect
 * as an absolute URL from it; production serves no plaintext. `effectiveRequestUrl` is the
 * middleware's option for exactly this (https://paraglidejs.com/server). */
function addressedUrl(request: Request): URL {
  const url = new URL(request.url);
  return new URL(`${url.pathname}${url.search}`, publicOrigin(request));
}

export default {
  async fetch(request: Request): Promise<Response> {
    // The web-page sandbox origin (task #490) serves its signed pages and nothing else: none of
    // the application's pages or APIs ever answer on it.
    if (isSandboxRequest(request, artifactSandboxOrigin())) return serveArtifactSandbox(request);
    if (!channelThreadUnreadQueueReady() && new URL(request.url).pathname === "/health")
      return textResponse("Service unavailable", { status: 503 });
    return isNonLocalizedRequest(request)
      ? handler.fetch(request)
      : paraglideMiddleware(request, () => handler.fetch(request), {
          effectiveRequestUrl: addressedUrl,
        });
  },
};
