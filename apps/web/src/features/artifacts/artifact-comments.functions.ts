import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { COMMENT_BODY_MAX } from "@lrm/coforge-sdk/agent";
import { commentDraftInput, commentFields } from "./artifact-comment-inputs";
import { artifactInputs } from "./artifact-inputs";

const { id } = artifactInputs;

const placeOf = (
  context: { workspaceId: string; user: { id: string } },
  data: { artifactId: string },
) => ({ workspaceId: context.workspaceId, artifactId: data.artifactId, userId: context.user.id });

const commentTarget = z.object({ artifactId: id, commentId: id }).strict();

export const loadArtifactComments = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, before: z.string().max(200).optional() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.list({
      ...placeOf(context, data),
      before: data.before,
    }),
  );

export const loadArtifactCommentsById = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, ids: z.array(id).min(1).max(100) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.byId({ ...placeOf(context, data), ids: data.ids }),
  );

export const loadArtifactMentionCandidates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.candidates(placeOf(context, data)),
  );

export const previewArtifactCommentAudience = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, body: z.string().max(COMMENT_BODY_MAX) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.willNotify({
      ...placeOf(context, data),
      body: data.body,
    }),
  );

export const postArtifactComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        comment: commentDraftInput,
        version: artifactInputs.version.optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const { id: commentId } = await productionArtifacts(context.db).comments.post({
      ...placeOf(context, data),
      comment: data.comment,
      version: data.version,
    });
    return { id: commentId };
  });

export const editArtifactComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, commentId: id, body: commentFields.body }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.edit({
      ...placeOf(context, data),
      commentId: data.commentId,
      body: data.body,
    }),
  );

export const deleteArtifactComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commentTarget)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.remove({
      ...placeOf(context, data),
      commentId: data.commentId,
    }),
  );

export const resolveArtifactComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commentTarget)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.resolve({
      ...placeOf(context, data),
      commentId: data.commentId,
    }),
  );

export const reopenArtifactComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commentTarget)
  .handler(({ context, data }) =>
    productionArtifacts(context.db).comments.reopen({
      ...placeOf(context, data),
      commentId: data.commentId,
    }),
  );
