import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import {
  productionArtifactShares,
  productionArtifacts,
} from "#src/server/artifacts/artifact-composition.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { postUserMessage } from "#src/server/conversations/user-message-post.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { artifactInputs } from "./artifact-inputs";
import { shareArtifactInputSchema } from "./artifact-share-input";

const { id } = artifactInputs;

const scopeOf = (context: { workspaceId: string; user: { id: string } }) => ({
  workspaceId: context.workspaceId,
  actor: { userId: context.user.id },
});

export const listArtifacts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: id.optional() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.list(scopeOf(context), data),
  );

export const loadArtifactCards = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactIds: z.array(id).min(1).max(100) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.cards(scopeOf(context), data.artifactIds),
  );

export const loadArtifactDocument = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, version: artifactInputs.version.optional() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.load(
      scopeOf(context),
      { artifactId: data.artifactId, version: data.version },
      { body: "markdown" },
    ),
  );

export const loadArtifactLinkSharing = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).publicLinks.read({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
    }),
  );

export const setArtifactLinkSharing = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, enabled: z.boolean() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).publicLinks.set({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
      enabled: data.enabled,
    }),
  );

export const setArtifactAccess = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, access: z.enum(["conversation", "workspace"]) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).visibility.change({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
      tier: data.access,
    }),
  );

export const loadArtifactAccessLoss = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).visibility.loss({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
    }),
  );

export const deleteArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(async ({ context, data }) => {
    await productionArtifacts(context.db).artifacts.delete({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      actor: { userId: context.user.id },
    });
    return { deleted: true as const };
  });

export const shareArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(shareArtifactInputSchema)
  .handler(({ context: { db, user, workspaceId }, data }) => {
    const publisher = createCentrifugoServerApi();
    const ports = {
      db,
      idempotency: getMessageRequestIdempotency(),
      publisher,
      realtime: new CentrifugoConversationRealtime(publisher),
      notifications: bestEffortMessageNotifier(db),
      prepareDirect: (workspace: string, userId: string, conversationId: string) =>
        new WorkspaceAssistants(db).prepareConversation(
          workspace,
          userId,
          conversationId,
          (input) => productionCloudComputers(db).ensureDefault(input),
        ),
    };
    return productionArtifactShares(db, (workspace) => artifactsEnabled(db, workspace)).share({
      workspaceId,
      actor: { userId: user.id },
      artifactId: data.artifactId,
      targets: data.destinations,
      note: data.note || undefined,
      requestId: data.requestId,
      unseen: data.unseen,
      send: ({ target, idempotencyKey, body }) =>
        postUserMessage(ports, {
          workspaceId,
          userId: user.id,
          conversationId: target,
          idempotencyKey,
          body,
        }),
    });
  });
