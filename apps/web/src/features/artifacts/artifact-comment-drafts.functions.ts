import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { draftInputs } from "./artifact-comment-draft-inputs";
import { artifactInputs } from "./artifact-inputs";

const placeOf = (
  context: { workspaceId: string; user: { id: string } },
  data: { artifactId: string },
) => ({ workspaceId: context.workspaceId, artifactId: data.artifactId, userId: context.user.id });

export const loadCommentDrafts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: artifactInputs.id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).drafts.list(placeOf(context, data)),
  );

export const createCommentDraft = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(draftInputs.create)
  .handler(({ context, data }) => {
    const { artifactId: _artifactId, ...draft } = data;
    return productionArtifacts(context.db).drafts.create({ ...placeOf(context, data), draft });
  });

export const editCommentDraft = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(draftInputs.edit)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).drafts.edit({
      ...placeOf(context, data),
      draftId: data.draftId,
      body: data.body,
      ...(data.anchor === undefined ? {} : { anchor: data.anchor }),
      ...(data.path === undefined ? {} : { path: data.path }),
    }),
  );

export const deleteCommentDraft = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(draftInputs.target)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).drafts.remove({
      ...placeOf(context, data),
      draftId: data.draftId,
    }),
  );

export const discardCommentDrafts = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: artifactInputs.id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).drafts.discardAll(placeOf(context, data)),
  );

export const submitCommentDrafts = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(draftInputs.submit)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).drafts.submit({
      ...placeOf(context, data),
      draftIds: data.draftIds,
      clientKey: data.clientKey,
    }),
  );

export const loadArtifactReview = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: artifactInputs.id, reviewId: artifactInputs.id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.review({
      ...placeOf(context, data),
      reviewId: data.reviewId,
    }),
  );
