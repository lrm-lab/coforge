import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { artifactInputs } from "./artifact-inputs";
import { ARTIFACT_TITLE_MAX } from "./artifact-title-limit";

const { id } = artifactInputs;

const placeOf = (
  context: { workspaceId: string; user: { id: string } },
  data: { artifactId: string },
) => ({ workspaceId: context.workspaceId, artifactId: data.artifactId, userId: context.user.id });

export const renameArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, title: z.string().max(ARTIFACT_TITLE_MAX) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).renames.rename({
      ...placeOf(context, data),
      title: data.title,
    }),
  );

export const loadArtifactVersions = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).versionHistory.list(placeOf(context, data)),
  );

export const openArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, version: artifactInputs.version.optional() }).strict())
  .handler(async ({ context, data }) => {
    await productionArtifacts(context.db).viewerPositions.open({
      ...placeOf(context, data),
      version: data.version,
    });
    return { opened: true as const };
  });

export const keepArtifactViewing = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(async ({ context, data }) => {
    await productionArtifacts(context.db).viewerPositions.heartbeat(placeOf(context, data));
    return { viewing: true as const };
  });

export const loadArtifactViewers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).viewerPositions.roster(placeOf(context, data)),
  );

export const loadArtifactFollowing = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).personFollows.read(placeOf(context, data)),
  );

export const setArtifactFollowing = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, following: z.boolean() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).personFollows.set({
      ...placeOf(context, data),
      following: data.following,
    }),
  );

export const loadArtifactFilePreview = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        version: artifactInputs.version.optional(),
        path: z.string().min(1).max(512),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).filePreview({
      ...placeOf(context, data),
      version: data.version,
      path: data.path,
    }),
  );
