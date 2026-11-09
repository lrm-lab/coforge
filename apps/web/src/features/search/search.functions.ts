import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readDeadline } from "#src/lib/read-deadline";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { searchTasks } from "#src/server/tasks/task-search.server";
import { messageSearchInputSchema, taskSearchInputSchema } from "./search.schemas";

/** One page of the messages the viewer may read in the current Workspace that match a search. A
 * full-text search of a large Workspace can take longer than other reads. */
export const searchWorkspaceMessages = createServerFn({ method: "GET" })
  .middleware([readDeadline(30_000), workspaceUserMiddleware])
  .validator(messageSearchInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return searchMessages(db, {
      ...data,
      workspaceId,
      userId: user.id,
      after: data.after ? new Date(data.after) : undefined,
      before: data.before ? new Date(data.before) : undefined,
    });
  });

/** The Tasks a search finds, in the conversations the viewer may read. */
export const searchWorkspaceTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(taskSearchInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return searchTasks(db, { ...data, workspaceId, userId: user.id });
  });
