import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "#src/lib/app-error";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";
import { ProjectImages } from "#src/server/projects/project-images.server";

export const Route = createFileRoute("/api/projects/$projectId/icon")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!z.uuid().safeParse(params.projectId).success) throw new AppError("NOT_FOUND");
          const image = await new ProjectImages(requireDatabaseClient()).read(
            user.id,
            params.projectId,
          );
          return new Response(image.body, { headers: privateImageHeaders(image.contentType) });
        } catch (error) {
          return privateResourceRefusal(error);
        }
      },
    },
  },
});
