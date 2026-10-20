import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { APP_KEY_MAX_LENGTH } from "#src/features/apps/app-registration";
import { AppError } from "#src/lib/app-error";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import type { AppRegistry } from "#src/server/apps/app-registry.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";

/**
 * An app's logo, where this deployment has no image CDN (`appLogoUrl`): served to people of a
 * Workspace where the app is installed. Setting and resetting it are `uploadWorkspaceAppLogo` and
 * `resetWorkspaceAppLogo`.
 */
export const Route = createFileRoute("/api/workspaces/$workspaceId/apps/$appKey/logo")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleAppLogoDownload(request, params),
    },
  },
});

type Params = { workspaceId: string; appKey: string };

export type AppLogoRouteDependencies = {
  authenticate(cookieHeader: string | undefined): Promise<{ id: string } | null>;
  registry(): Pick<AppRegistry, "readAppLogo">;
};

const routeDependencies: AppLogoRouteDependencies = {
  authenticate: optionalBrowserUser,
  registry: () => createAppRegistry(requireDatabaseClient()),
};

const paramsSchema = z.object({
  workspaceId: z.uuid(),
  appKey: z.string().min(1).max(APP_KEY_MAX_LENGTH),
});

export async function handleAppLogoDownload(
  request: Request,
  params: Params,
  dependencies: AppLogoRouteDependencies = routeDependencies,
): Promise<Response> {
  try {
    const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    if (!user) throw new AppError("ACCESS_DENIED");
    if (!paramsSchema.safeParse(params).success) throw new AppError("NOT_FOUND");
    const logo = await dependencies
      .registry()
      .readAppLogo(user.id, params.workspaceId, params.appKey);
    return new Response(logo.body, { headers: privateImageHeaders(logo.contentType) });
  } catch (error) {
    return privateResourceRefusal(error);
  }
}
