import { createServerFn } from "@tanstack/react-start";
import { TASK_PRIORITY_LEVELS } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { browserTaskBoard } from "#src/server/tasks/browser-task-board.server";

export const makeTaskFromMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        conversationId: z.uuid(),
        messageId: z.uuid(),
        idempotencyKey: z.uuid(),
        alongside: z.boolean().optional(),
        priority: z.enum(TASK_PRIORITY_LEVELS).optional(),
      })
      .strict(),
  )
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    const { tasks } = await browserTaskBoard(db).execute(
      { workspaceId, userId: user.id },
      { operation: "convert", ...data },
    );
    return { task: tasks[0]! };
  });
