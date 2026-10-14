import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "#src/paraglide/server";
import { publicOrigin } from "#src/server/http/public-origin.server";
import { assertStartupConfig } from "#src/server/startup-config.server";
import { ensureWorkspaceMemoryLifecycle } from "#src/server/workspace-memory/lifecycle.server";
import { startWeeklyReportScheduleTickFromEnv } from "#src/server/records/weekly-report-schedule-tick.server";

// Fail the boot, not the first request, on invalid deployment configuration.
await assertStartupConfig();
// Backend-owned memory sweep: independent of incidental Centrifugo traffic.
ensureWorkspaceMemoryLifecycle();
// Optional in-process clock for weekly-report auto-send. No-op unless
// COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS is set; external HTTP cron remains valid.
startWeeklyReportScheduleTickFromEnv();

export function isNonLocalizedRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/") ||
    // The two bootstrap installer entry points (`curl .../computer/install.sh | sh`,
    // `irm .../computer/install.ps1 | iex`) must resolve at exactly this path in every
    // environment (docs/release/local-feed-hosting.md). Paraglide's
    // URL-pattern middleware otherwise 307-redirects any unprefixed path to `/en/...`, which
    // both breaks the documented URL and turns a `curl | sh` pipeline's error case into an
    // 18 KB HTML not-found page instead of plain text.
    pathname === "/computer/install.sh" ||
    pathname === "/computer/install.ps1"
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
    return isNonLocalizedRequest(request)
      ? handler.fetch(request)
      : paraglideMiddleware(request, () => handler.fetch(request), {
          effectiveRequestUrl: addressedUrl,
        });
  },
};
