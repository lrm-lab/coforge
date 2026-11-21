import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { browserActivityInbox } from "#src/server/inbox/browser-activity-inbox.server";
import { artifactInputs } from "./artifact-inputs";
import { ARTIFACT_ROSTER_SIZE } from "./artifact-presence-channel";
import { withinArtifactTitleLimit } from "./artifact-title-limit";

const { id } = artifactInputs;

const placeOf = (
  context: { workspaceId: string; user: { id: string } },
  data: { artifactId: string },
) => ({ workspaceId: context.workspaceId, artifactId: data.artifactId, userId: context.user.id });

export const renameArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        title: z.string().refine(withinArtifactTitleLimit),
      })
      .strict(),
  )
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
    const place = placeOf(context, data);
    const roster = await productionArtifacts(context.db).viewerPositions.open({
      ...place,
      version: data.version,
    });
    void browserActivityInbox(context.db)
      .artifactOpened(place.workspaceId, place.userId)
      .catch(() => undefined);
    return roster;
  });

export const markArtifactSeen = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(async ({ context, data }) => {
    const place = placeOf(context, data);
    const changed = await productionArtifacts(context.db).viewerPositions.seen(place);
    if (changed)
      await browserActivityInbox(context.db).artifactOpened(place.workspaceId, place.userId);
    return { seen: true as const };
  });

export const loadArtifactViewers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({ artifactId: id, viewing: z.array(id).max(ARTIFACT_ROSTER_SIZE).optional() })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).viewerPositions.roster({
      ...placeOf(context, data),
      viewing: data.viewing,
    }),
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
