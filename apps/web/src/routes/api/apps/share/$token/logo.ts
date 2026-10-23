import { createFileRoute } from "@tanstack/react-router";

import { AppError } from "#src/lib/app-error";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import type { AppInstallations } from "#src/server/app-marketplace/app-installations.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";

/**
 * The logo of the app a private share link names, for the share page (where there is no image
 * CDN): the token is the authorization, checked on every read, and the answer is never cached, so
 * revoking the link ends it at once. The viewer-based logo route does not serve an unlisted app
 * to a Workspace that has not installed it.
 */
export const Route = createFileRoute("/api/apps/share/$token/logo")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleSharedLogoDownload(request, params),
    },
  },
});

export type SharedLogoRouteDependencies = {
  authenticate(cookieHeader: string | undefined): Promise<{ id: string } | null>;
  installations(): Pick<AppInstallations, "sharedLogo">;
  open(objectKey: string): Promise<{ body: BodyInit } | null>;
};

const routeDependencies: SharedLogoRouteDependencies = {
  authenticate: optionalBrowserUser,
  installations: () => createAppInstallations(requireDatabaseClient()),
  open: async (objectKey) => (await getPublicImageStorage()).open(objectKey),
};

export async function handleSharedLogoDownload(
  request: Request,
  params: { token: string },
  dependencies: SharedLogoRouteDependencies = routeDependencies,
): Promise<Response> {
  try {
    const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    if (!user) throw new AppError("ACCESS_DENIED");
    const logo = await dependencies.installations().sharedLogo(params.token);
    const file = await dependencies.open(logo.objectKey);
    if (!file) throw new AppError("NOT_FOUND");
    return new Response(file.body, {
      headers: {
        ...privateImageHeaders(logo.contentType),
        // Not the year the shared headers allow: revoking the link must end access at once.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return privateResourceRefusal(error);
  }
}
