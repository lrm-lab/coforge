import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { artifactInputs } from "./artifact-inputs";
import {
  productionArtifactAbuseReporter,
  productionArtifactLinkOpen,
  productionArtifactSandbox,
} from "#src/server/artifacts/artifact-composition.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";

export const loadArtifactSandboxLink = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: artifactInputs.id,
        version: artifactInputs.version.optional(),
        path: z.string().min(1).max(512).optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const link = await productionArtifactSandbox(context.db).link({
      workspaceId: context.workspaceId,
      userId: context.user.id,
      artifactId: data.artifactId,
      version: data.version,
      path: data.path,
      embedderOrigin: publicOrigin(getRequest()),
    });
    return {
      url: link.url,
      version: link.version,
      expiresAt: link.expiresAt.toISOString(),
      viewer: link.viewer,
      level: link.level,
    };
  });

export const resolvePublicArtifactAccess = createServerFn({ method: "GET" })
  .validator(z.object({ artifactId: artifactInputs.id }).strict())
  .handler(async ({ data }) => {
    declareNoStore();
    const user = await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    if (!user) return { signedIn: false, memberWorkspaceSlug: null as string | null };
    const db = requireDatabaseClient();
    const artifact = await db.artifact.findFirst({
      where: {
        id: data.artifactId,
        deletedAt: null,
        workspace: { memberships: { some: { userId: user.id } } },
      },
      select: { workspace: { select: { slug: true } } },
    });
    return { signedIn: true, memberWorkspaceSlug: artifact?.workspace.slug ?? null };
  });

export const openLinkArtifact = createServerFn({ method: "GET" })
  .validator(z.object({ artifactId: artifactInputs.id }).strict())
  .handler(async ({ data }) => {
    return productionArtifactLinkOpen(requireDatabaseClient()).open({
      artifactId: data.artifactId,
      client: clientAddress(getRequest()),
    });
  });

export const reportPublicArtifactAbuse = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        artifactId: artifactInputs.id,
        reason: z.enum(["spam", "phishing", "harassment", "copyright", "other"]),
        details: z.string().max(1000).optional(),
      })
      .strict(),
  )
  .handler(async ({ data }) => {
    return productionArtifactAbuseReporter(requireDatabaseClient()).submit({
      artifactId: data.artifactId,
      reason: data.reason,
      details: data.details,
      client: clientAddress(getRequest()),
    });
  });
