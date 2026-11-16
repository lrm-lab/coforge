import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { artifactInputs } from "./artifact-inputs";

export const GALLERY_PAGE_SIZE = 24;

export const loadArtifactGallery = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        query: z.string().max(200).optional(),
        scope: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("conversation"), conversationId: artifactInputs.id }),
            z.object({ kind: z.literal("workspace") }),
            z.object({ kind: z.literal("link") }),
          ])
          .optional(),
        authorAgentIds: z.array(artifactInputs.id).max(50).optional(),
        related: z.boolean().optional(),
        sort: z.enum(["opened", "updated"]),
        cursor: z.string().max(200).optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).gallery.page({
      ...data,
      workspaceId: context.workspaceId,
      userId: context.user.id,
      limit: GALLERY_PAGE_SIZE,
    }),
  );

export const loadArtifactMarks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactIds: z.array(artifactInputs.id).min(1).max(100) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).gallery.marks({
      workspaceId: context.workspaceId,
      userId: context.user.id,
      artifactIds: data.artifactIds,
    }),
  );
