import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { browserTaskBoard } from "#src/server/tasks/browser-task-board.server";
import { SourceMessageTaken } from "#src/server/tasks/task-conversation-creation.server";
import { taskConversationsEnabled } from "#src/server/tasks/task-conversations-gate.server";

/** Whether task conversations apply in the viewer's Workspace: a member may not read the
 * experiments themselves, only whether this one is on. */
export const loadTaskConversationsOn = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => ({
    on: await taskConversationsEnabled(db, { workspaceId }),
  }));

/**
 * A new Task made from a message, the message its source (`convert` under task conversations).
 * A message someone else's unfinished Task already came from answers with that Task instead
 * (`taken`), unless the person asked to make theirs beside it (`alongside`).
 */
export const makeTaskFromMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        conversationId: z.uuid(),
        messageId: z.uuid(),
        idempotencyKey: z.uuid(),
        alongside: z.boolean().optional(),
      })
      .strict(),
  )
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    try {
      const { tasks } = await browserTaskBoard(db).execute(
        { workspaceId, userId: user.id },
        { operation: "convert", ...data },
      );
      return { task: tasks[0]!, taken: null };
    } catch (error) {
      if (error instanceof SourceMessageTaken) {
        const { taskNumber, holderName } = error.details!;
        return { task: null, taken: { number: Number(taskNumber), holder: String(holderName) } };
      }
      throw error;
    }
  });
