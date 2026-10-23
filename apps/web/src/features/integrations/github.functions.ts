import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";

import { AppError } from "#src/lib/app-error";
import {
  authMiddleware,
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import {
  GITHUB_RETURN_TARGETS,
  githubInstallationStateCookie,
  githubReturnCookie,
  githubStateCookie,
} from "#src/server/integrations/github-http.server";

/** Where the callback comes back to: Settings (the default) or the Workspace home, from where the
 * setup checklist starts the flow. A closed set, never a path. */
const startInput = z.object({ returnTo: z.enum(GITHUB_RETURN_TARGETS).optional() }).optional();

async function requiredGitHub() {
  const github = await configuredGitHub();
  if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return github;
}

type GitHubGate = NonNullable<Awaited<ReturnType<typeof configuredGitHub>>>;

/**
 * Starts one GitHub flow for the page's Workspace: checks the request's origin (a sibling subdomain
 * must not start a connection with a production session), begins the flow, and sets its state
 * cookie and the cookie that brings the callback back to this Workspace.
 */
async function startFlow(
  context: WorkspaceUserContext,
  input: z.infer<typeof startInput>,
  begin: (
    github: GitHubGate,
  ) => Promise<{ state: string; url: string }> | { state: string; url: string },
  stateCookie: (state: string) => string,
) {
  const github = await requiredGitHub();
  if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
    throw new AppError("ACCESS_DENIED");
  const attempt = await begin(github);
  const { slug } = await context.db.workspace.findUniqueOrThrow({
    where: { id: context.workspaceId },
    select: { slug: true },
  });
  setResponseHeader("set-cookie", [
    stateCookie(attempt.state),
    githubReturnCookie(slug, input?.returnTo),
  ]);
  return { url: attempt.url };
}

export const getGitHubConnection = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    const userId = context.user.id;
    const github = await configuredGitHub();
    if (!github) return { status: "unconfigured" as const, login: null, installUrl: null };
    return github.connection.overview(userId);
  });

export const startGitHubConnection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startInput)
  .handler(({ context, data }) =>
    startFlow(
      context,
      data,
      (github) => github.connection.begin(context.user.id),
      githubStateCookie,
    ),
  );

export const startGitHubReauthorization = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startInput)
  .handler(({ context, data }) =>
    startFlow(
      context,
      data,
      (github) => github.connection.begin(context.user.id, "reauthorize"),
      githubStateCookie,
    ),
  );

export const startGitHubInstallation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startInput)
  .handler(({ context, data }) =>
    startFlow(
      context,
      data,
      (github) => github.connection.beginInstallation(),
      githubInstallationStateCookie,
    ),
  );

export const refreshGitHubConnection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    return github.connection.sync(userId);
  });

export const disconnectGitHub = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    await github.connection.disconnect(userId);
    setResponseHeader("set-cookie", githubStateCookie(""));
    return { ok: true as const };
  });

export const listAccessibleGitHubRepositories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) =>
    (await requiredGitHub()).connection.accessibleRepositories(context.user.id),
  );
