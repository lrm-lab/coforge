import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { humanLabel } from "#src/lib/human-label";
import { AppError } from "#src/lib/app-error";
import { readSessionSecret } from "#src/server/auth/config.server";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";
import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import { clusterToken, productionHostDirectory } from "#src/server/hosts/host-production.server";
import { publicOrigin } from "#src/server/http/public-origin.server";
import { PrismaServerConnection } from "#src/server/db/repositories/server-connection.repositories.server";
import {
  CloudServiceAttempts,
  clearCloudServiceCookie,
  cloudServiceCookieValue,
  cloudServicePasswordAccepted,
  cloudServicePasswordConfigured,
  cloudServiceUnlockValid,
  sealCloudServiceUnlock,
  serializeCloudServiceCookie,
} from "#src/server/workspaces/cloud-service-access.server";
import { hostBootstrapScript } from "#src/server/workspaces/host-bootstrap.server";
import {
  ServerConnectionError,
  WorkspaceServerConnection,
  type CloudComputerServicePage,
  type ServerConnectionView,
} from "#src/server/workspaces/server-connection.server";
import type { PrismaClient } from "#src/generated/prisma/client";

const attempts = new CloudServiceAttempts();

function connections(db: PrismaClient) {
  return new WorkspaceServerConnection(new PrismaServerConnection(db));
}

function secureCookie(): boolean {
  return new URL(getRequest().url).protocol === "https:";
}

async function requireUnlock(): Promise<void> {
  const secret = await readSessionSecret(Bun.env);
  const token = cloudServiceCookieValue(getRequest().headers.get("cookie"));
  if (!cloudServiceUnlockValid(token, new Date(), secret)) throw new AppError("ACCESS_DENIED");
}

export const unlockCloudComputerService = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ password: z.string().max(200) }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const now = new Date();
    const configured = Bun.env.COFORGE_CLOUD_SERVICE_PASSWORD;
    if (!cloudServicePasswordConfigured(configured)) {
      return { ok: false as const, reason: "unconfigured" as const };
    }
    if (!attempts.allowed(context.user.id, now)) {
      return { ok: false as const, reason: "limited" as const };
    }
    if (!cloudServicePasswordAccepted(data.password, configured)) {
      return { ok: false as const, reason: "rejected" as const };
    }
    let secret: string;
    try {
      secret = await readSessionSecret(Bun.env);
    } catch {
      return { ok: false as const, reason: "unavailable" as const };
    }
    const request = getRequest();
    setResponseHeader(
      "Set-Cookie",
      serializeCloudServiceCookie(sealCloudServiceUnlock(now, secret), secureCookie()),
    );
    const page = await cloudServicePage(context.db, publicOrigin(request), now);
    return { ok: true as const, page };
  });

export const lockCloudComputerService = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async () => {
    declareNoStore();
    setResponseHeader("Set-Cookie", clearCloudServiceCookie(secureCookie()));
    return { ok: true as const };
  });

export const loadCloudComputerService = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    await requireUnlock();
    return cloudServicePage(context.db, publicOrigin(getRequest()), new Date());
  });

export const downloadHostBootstrap = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ clusterName: z.string().max(200), image: z.string().max(200) }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    await requireUnlock();
    const feed = resolveReleaseFeedUrl(Bun.env);
    if (!feed) return { ok: false as const, reason: "no-feed" as const };
    let binding: { clusterName: string | null; nodeKey: string | null };
    try {
      binding = await productionHostDirectory(context.db).operatorBinding();
    } catch (error) {
      if (error instanceof HostDirectoryError && error.status === 503) {
        return { ok: false as const, reason: "no-token" as const };
      }
      throw error;
    }
    try {
      return {
        ok: true as const,
        filename: "coforge-host-bootstrap.sh",
        script: hostBootstrapScript({
          origin: publicOrigin(getRequest()),
          releaseFeed: feed,
          token: clusterToken() ?? "",
          nodeKey: binding.nodeKey,
          clusterName: data.clusterName,
          image: data.image,
        }),
      };
    } catch (error) {
      if (error instanceof ServerConnectionError) {
        return { ok: false as const, reason: "invalid" as const };
      }
      throw error;
    }
  });

async function cloudServicePage(
  db: PrismaClient,
  origin: string,
  now: Date,
): Promise<CloudComputerServicePage & { clusterName: string | null }> {
  const page = await connections(db).servicePage(origin, now);
  return { ...page, clusterName: await boundClusterName(db) };
}

async function boundClusterName(db: PrismaClient): Promise<string | null> {
  try {
    return (await productionHostDirectory(db).operatorBinding()).clusterName;
  } catch (error) {
    if (error instanceof HostDirectoryError) return null;
    throw error;
  }
}

function reject(error: unknown): never {
  if (error instanceof ServerConnectionError) {
    throw new AppError(error.status === 409 ? "CONFLICT" : "INVALID_INPUT");
  }
  throw error;
}

export const loadServerConnection = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<ServerConnectionView> => {
    declareNoStore();
    await requireUnlock();
    return connections(context.db).read(context.workspaceId, new Date());
  });

export const submitServerConnection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    await requireUnlock();
    const workspace = await context.db.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { slug: true },
    });
    if (!workspace) throw new AppError("NOT_FOUND");
    const person = await context.db.user.findUnique({
      where: { id: context.user.id },
      select: { displayName: true, username: true },
    });
    if (!person) throw new AppError("NOT_FOUND");
    try {
      return await connections(context.db).submit({
        workspaceId: context.workspaceId,
        userId: context.user.id,
        submittedByName: humanLabel(person),
        installOrigin: publicOrigin(getRequest()),
        workspaceSlug: workspace.slug,
        now: new Date(),
      });
    } catch (error) {
      reject(error);
    }
  });
