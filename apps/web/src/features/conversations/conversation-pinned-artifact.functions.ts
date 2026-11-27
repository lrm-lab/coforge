import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  readConversationPinnedArtifact,
  setConversationPinnedArtifact,
} from "#src/server/conversations/conversation-pinned-artifact.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

const uuid = z.string().uuid();

export const loadConversationPinnedArtifact = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: uuid }).strict())
  .handler(({ context, data }) =>
    readConversationPinnedArtifact(context.db, {
      workspaceId: context.workspaceId,
      conversationId: data.conversationId,
      userId: context.user.id,
    }),
  );

export const updateConversationPinnedArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: uuid, artifactId: uuid.nullable() }).strict())
  .handler(({ context, data }) =>
    setConversationPinnedArtifact(
      context.db,
      new CentrifugoConversationRealtime(createCentrifugoServerApi()),
      {
        workspaceId: context.workspaceId,
        conversationId: data.conversationId,
        userId: context.user.id,
        artifactId: data.artifactId,
      },
    ),
  );
