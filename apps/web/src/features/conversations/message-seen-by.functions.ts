import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";

export const loadMessageSeenBy = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid(), messageId: z.uuid() }))
  .handler(({ context: { db, user, workspaceId }, data }) =>
    readMessageSeenBy(db, {
      workspaceId,
      userId: user.id,
      ...data,
    }),
  );
