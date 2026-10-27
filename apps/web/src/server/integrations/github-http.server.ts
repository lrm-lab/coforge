import { timingSafeEqual } from "node:crypto";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { readPreferredWorkspaceSlug } from "#src/server/workspaces/selection.server";
import { isAppError } from "#src/lib/app-error";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { configuredGitHub, readGitHubConfig } from "./github-config.server";
import { applyGitHubWebhookEvent, verifyGitHubWebhookSignature } from "./github-webhook.server";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import type {
  GitHubAuthorizationResult,
  GitHubCallbackFailure,
} from "#src/features/integrations/github-callback";

export const GITHUB_STATE_COOKIE = "__Host-coforge-github-state";
export const GITHUB_INSTALL_STATE_COOKIE = "__Host-coforge-github-install-state";
/** The Workspace a connection or installation was started from, and where in it the callback
 * returns to: `<slug>` for its Settings, `<slug>:home` for its home page. */
export const GITHUB_RETURN_COOKIE = "__Host-coforge-github-return";

export function githubStateCookie(state: string) {
  return `${GITHUB_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${state ? 600 : 0}`;
}

export function githubInstallationStateCookie(state: string) {
  return `${GITHUB_INSTALL_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${state ? 600 : 0}`;
}

function cookieValue(header: string, name: string) {
  return (
    header
      .split(/;\s*/)
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  );
}

/** Where in the Workspace the callback returns. A closed set: the cookie never names a path. */
export const GITHUB_RETURN_TARGETS = ["settings", "home"] as const;
export type GitHubReturnTarget = (typeof GITHUB_RETURN_TARGETS)[number];

export function githubReturnCookie(workspaceSlug: string, target: GitHubReturnTarget = "settings") {
  const value = target === "home" && workspaceSlug ? `${workspaceSlug}:home` : workspaceSlug;
  return `${GITHUB_RETURN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${workspaceSlug ? 600 : 0}`;
}

export function validGitHubInstallationState(cookie: string, state: string) {
  if (!cookie || cookie.length > 256 || state.length > 256) return false;
  const expected = Buffer.from(cookie);
  const actual = Buffer.from(state);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The return cookie's Workspace slug and target; anything but `home` is Settings. */
function returnPlace(cookieHeader: string) {
  const [slug = "", target, ...extra] = cookieValue(cookieHeader, GITHUB_RETURN_COOKIE).split(":");
  return { slug, home: target === "home" && extra.length === 0 };
}

/**
 * Where the callback returns: the Workspace home when the flow was started from there and did not
 * fail, otherwise Settings' Integrations section (which says what went wrong) in the Workspace the
 * flow was started from. For an installation started on GitHub, the Workspace the browser last
 * opened (the connection is the User's, so any of theirs shows it); the app root when neither is
 * known.
 */
function returnLocation(cookieHeader: string, github?: "connected" | GitHubCallbackFailure) {
  const place = returnPlace(cookieHeader);
  const slug = place.slug || readPreferredWorkspaceSlug(cookieHeader);
  if (!slug || !isValidWorkspaceSlug(slug)) return "/";
  // The flow's own Workspace and a good outcome; a failure is explained in Settings.
  if (place.slug && place.home && (github === undefined || github === "connected"))
    return workspacePath(slug);
  return workspacePath(slug, `/settings?section=integrations${github ? `&github=${github}` : ""}`);
}

/** A failure before or around `GitHubConnection.complete`: the stage and a short reason only. */
function logCallbackFailure(reason: string) {
  console.warn(JSON.stringify({ event: "github.authorization_failed", stage: "callback", reason }));
}

export async function githubCallbackHandler({ request }: { request: Request }) {
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
  if (!user) return new Response(null, { status: 401, headers });
  const cookieHeader = request.headers.get("cookie") ?? "";
  const params = new URL(request.url).searchParams;
  const setupAction = params.get("setup_action");
  if (setupAction === "install") {
    return githubInstallationCallback(cookieHeader, user.id, params, headers);
  }
  const state = params.get("state") ?? "";
  // GitHub can return from an independently initiated installation with a code but
  // no CoForge state. Do NOT link an identity or exchange that unbound code.
  if (!state) {
    headers.set("location", returnLocation(cookieHeader));
    headers.append("set-cookie", githubReturnCookie(""));
    return new Response(null, { status: 303, headers });
  }
  headers.set("set-cookie", githubStateCookie(""));
  let connected: GitHubAuthorizationResult = false;
  try {
    const github = await configuredGitHub();
    const cookie = cookieValue(cookieHeader, GITHUB_STATE_COOKIE);
    if (github)
      connected = await github.connection.complete(
        user.id,
        cookie,
        state,
        params.has("error") ? "" : (params.get("code") ?? ""),
      );
    else logCallbackFailure("not_configured");
  } catch (error) {
    // Never put GitHub response bodies, authorization codes or secrets in errors/logs: the log
    // line names the stage and a short reason only (`GitHubConnection.complete` logs its own).
    logCallbackFailure(isAppError(error) ? error.code.toLowerCase() : "error");
  }
  if (connected === true) {
    try {
      const github = await configuredGitHub();
      if (github) {
        const overview = await github.connection.overview(user.id);
        if (overview.status === "pending_installation") {
          const installation = github.connection.beginInstallation();
          headers.append("set-cookie", githubInstallationStateCookie(installation.state));
          headers.set("location", installation.url);
          return new Response(null, { status: 303, headers });
        }
      }
    } catch {
      // The connection was completed. Leave the user on Settings if the
      // installation lookup is temporarily unavailable.
    }
  }
  headers.set(
    "location",
    returnLocation(cookieHeader, connected === true ? "connected" : connected || "error"),
  );
  headers.append("set-cookie", githubReturnCookie(""));
  return new Response(null, { status: 303, headers });
}

async function githubInstallationCallback(
  cookieHeader: string,
  userId: string,
  params: URLSearchParams,
  headers: Headers,
) {
  headers.set("location", returnLocation(cookieHeader));
  headers.set("set-cookie", githubInstallationStateCookie(""));
  headers.append("set-cookie", githubReturnCookie(""));
  const state = params.get("state") ?? "";
  const cookie = cookieValue(cookieHeader, GITHUB_INSTALL_STATE_COOKIE);
  if (!validGitHubInstallationState(cookie, state)) {
    headers.set("location", returnLocation(cookieHeader, "error"));
    return new Response(null, { status: 303, headers });
  }
  try {
    const github = await configuredGitHub();
    if (github) await github.connection.sync(userId);
  } catch {
    headers.set("location", returnLocation(cookieHeader, "error"));
  }
  return new Response(null, { status: 303, headers });
}

const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
const GITHUB_EVENT_HEADER = "x-github-event";

/**
 * GitHub subscribes here instead of the settings page polling api.github.com (slow and
 * sometimes timing out from the production server's network path).
 * Always reads the raw body once and verifies its signature before any JSON parsing.
 */
export async function githubWebhookHandler({ request }: { request: Request }) {
  const headers = new Headers({ "cache-control": "no-store" });
  // A misconfigured secret file (e.g. not mounted) is an operator problem, not a
  // crash: answer 503 so GitHub's delivery log shows the failure plainly.
  const config = await readGitHubConfig().catch(() => null);
  if (!config || !config.webhookSecret) return new Response(null, { status: 503, headers });
  const rawBody = await request.text();
  if (
    !verifyGitHubWebhookSignature(
      config.webhookSecret,
      rawBody,
      request.headers.get(GITHUB_SIGNATURE_HEADER),
    )
  )
    return new Response(null, { status: 401, headers });
  const event = request.headers.get(GITHUB_EVENT_HEADER) ?? "";
  try {
    // Never log GitHub webhook bodies: they can carry account and installation details.
    const payload: unknown = JSON.parse(rawBody);
    await applyGitHubWebhookEvent(requireDatabaseClient(), config, event, payload);
  } catch {
    // Malformed JSON or an unexpected payload shape. GitHub retries non-2xx responses,
    // but a payload we cannot understand will not become understandable on retry either.
  }
  // GitHub retries non-2xx responses. Respond 204 for both handled and ignored event types
  // so an event type this handler does not care about is never retried.
  return new Response(null, { status: 204, headers });
}
