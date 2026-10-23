import { safeReturnTo } from "#src/features/auth/return-to";
import type { getGitHubConnection } from "#src/features/integrations/github.functions";
import { splitWorkspacePath, workspacePath } from "#src/features/workspaces/workspace-url";
import { locales } from "#src/paraglide/runtime";

/** The viewer's GitHub connection state, as `getGitHubConnection` reports it. */
export type GitHubStepStatus = Awaited<ReturnType<typeof getGitHubConnection>>["status"];

/** Which GitHub flow the step's main button starts. */
export type GitHubStepAction = "connect" | "install" | "reauthorize";

export type GitHubStepPlan =
  | { kind: "skip"; href: string }
  | { kind: "ask"; action: GitHubStepAction; next: string };

/** The one status-to-flow mapping (the step and the setup checklist both use it); `null` when
 * there is no flow to start: GitHub is not configured, or the viewer is connected. */
export function githubStepAction(status: GitHubStepStatus): GitHubStepAction | null {
  switch (status) {
    case "disconnected":
      return "connect";
    case "pending_installation":
      return "install";
    case "reauthorize":
      return "reauthorize";
    case "unconfigured":
    case "connected":
      return null;
  }
}

/** Whether `next` is a Workspace's own "Connect GitHub" step: going on to it would loop. */
function isGitHubStepPath(next: string): boolean {
  const rest = splitWorkspacePath(next)?.rest ?? "";
  return /^\/connect-github(?:[/?#]|$)/.test(rest);
}

/**
 * What the step after creating a Workspace does: nothing to ask when GitHub is not configured for
 * the deployment or the viewer is connected, so it goes straight on to `next`; otherwise it asks,
 * with the flow the status calls for. `next` is a page of this site (anything else is dropped),
 * defaulting to the Workspace home.
 */
export function githubStepPlan(input: {
  status: GitHubStepStatus;
  slug: string;
  next?: string;
}): GitHubStepPlan {
  const safe = safeReturnTo(input.next);
  const next = safe && !isGitHubStepPath(safe) ? safe : workspacePath(input.slug);
  const action = githubStepAction(input.status);
  return action ? { kind: "ask", action, next } : { kind: "skip", href: next };
}

/** The step's page for a Workspace (de-localized), remembering `next` unless it is the home. */
export function githubStepHref(slug: string, next?: string): string {
  const base = workspacePath(slug, "/connect-github");
  return next && next !== workspacePath(slug) ? `${base}?next=${encodeURIComponent(next)}` : base;
}

/** Whether a first sign-in has nowhere particular to go on to: someone arriving through an invite
 * or join link carries a `returnTo` and goes on there as before. The start page is `/` or a locale root (`/en`). */
export function isDefaultStartPage(returnTo: string | undefined): boolean {
  if (returnTo === undefined || returnTo === "/") return true;
  const root = returnTo.replace(/\/$/, "");
  return locales.some((locale) => root === `/${locale}`);
}
