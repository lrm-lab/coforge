import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getRequest, setCookie } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";

import { AppError } from "#src/lib/app-error";
import {
  authMiddleware,
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import {
  GITHUB_INSTALL_STATE_COOKIE,
  GITHUB_RETURN_COOKIE,
  GITHUB_STATE_COOKIE,
} from "#src/server/integrations/github-http.server";

const GITHUB_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
};

async function requiredGitHub() {
  const github = await configuredGitHub();
  if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return github;
}

type GitHubGate = NonNullable<Awaited<ReturnType<typeof configuredGitHub>>>;

async function startFlow(
  context: WorkspaceUserContext,
  begin: (
    github: GitHubGate,
  ) => Promise<{ state: string; url: string }> | { state: string; url: string },
  stateCookieName: string,
) {
  const github = await requiredGitHub();
  if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
    throw new AppError("ACCESS_DENIED");
  const attempt = await begin(github);
  const { slug } = await context.db.workspace.findUniqueOrThrow({
    where: { id: context.workspaceId },
    select: { slug: true },
  });
  setCookie(stateCookieName, attempt.state, { ...GITHUB_COOKIE_OPTIONS, maxAge: 600 });
  setCookie(GITHUB_RETURN_COOKIE, slug, { ...GITHUB_COOKIE_OPTIONS, maxAge: 600 });
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
  .handler(({ context }) =>
    startFlow(context, (github) => github.connection.begin(context.user.id), GITHUB_STATE_COOKIE),
  );

export const startGitHubReauthorization = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context }) =>
    startFlow(
      context,
      (github) => github.connection.begin(context.user.id, "reauthorize"),
      GITHUB_STATE_COOKIE,
    ),
  );

export const startGitHubInstallation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context }) =>
    startFlow(
      context,
      (github) => github.connection.beginInstallation(),
      GITHUB_INSTALL_STATE_COOKIE,
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
    deleteCookie(GITHUB_STATE_COOKIE, GITHUB_COOKIE_OPTIONS);
    return { ok: true as const };
  });

export const listAccessibleGitHubRepositories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) =>
    (await requiredGitHub()).connection.accessibleRepositories(context.user.id),
  );
