import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "#src/lib/app-error";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { ProjectFiles } from "#src/server/projects/project-files.server";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";

/** Streams one repository file as a download, read with the requesting User's GitHub token. */
export const Route = createFileRoute("/api/projects/$projectId/raw/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!z.uuid().safeParse(params.projectId).success) throw new AppError("NOT_FOUND");
          const file = await new ProjectFiles(requireDatabaseClient()).download(
            user.id,
            params.projectId,
            params._splat ?? "",
          );
          return new Response(file.body, {
            headers: {
              // Repository content is untrusted: never let the browser render it on this origin.
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
              "X-Content-Type-Options": "nosniff",
              "cache-control": PRIVATE_NO_STORE,
              Vary: "Cookie",
            },
          });
        } catch (error) {
          return privateResourceRefusal(error);
        }
      },
    },
  },
});
