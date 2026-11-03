import { canAssignOther } from "#src/server/tasks/task-assignment-authority.server";
import { TASK_STATUSES, type TaskCommand } from "@lrm/coforge-sdk/internal";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { refuseUnclaimed } from "#src/server/tasks/task-claims.server";
import { browserTaskBoard } from "#src/server/tasks/browser-task-board.server";
import { CONVERSATION_TASK_NUMBERS_MAX } from "./conversation-task-subset";
import { taskCommand } from "./task-command-schema";

/** What the viewer may do on the board besides the ordinary status moves: owner and admin set
 * any status. The board reads it once per Workspace and offers only the moves the server accepts. */
export const loadTaskBoardAuthority = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).authority(workspaceId, user.id);
  });

export const loadTaskOverview = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).overview(workspaceId, user.id);
  });

/** The unfinished Tasks of one Project the viewer may read, for the Project page. */
export const loadProjectTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ projectId: z.uuid() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).projectTasks({ workspaceId, userId: user.id }, data.projectId);
  });

/** One Task as the Tasks page shows it, in any status; null when the viewer cannot see it. */
export const loadOverviewTask = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid(), number: z.number().int().positive() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).overviewTask({ workspaceId, userId: user.id }, data);
  });

/**
 * The part of one conversation's Tasks its page shows (`ConversationTaskSubset`): some statuses,
 * a message window by sequence, some numbers — every one given applies. The conversation's Tasks
 * collection (`conversation-tasks-collection.ts`) sends the predicate of each live query here.
 */
export const loadConversationTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        conversationId: z.uuid(),
        statuses: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length).optional(),
        numbers: z
          .array(z.number().int().positive())
          .min(1)
          .max(CONVERSATION_TASK_NUMBERS_MAX)
          .optional(),
        sequenceFrom: z.number().int().nonnegative().optional(),
        sequenceTo: z.number().int().nonnegative().optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const { conversationId, ...subset } = data;
    return new TaskBoard(db).conversationTasks(
      { workspaceId, userId: user.id },
      conversationId,
      subset,
    );
  });

/** Where a finished-work read looks: the Workspace Tasks page, or one conversation's Tasks tab. */
const finishedScope = {
  conversationId: z.uuid().optional(),
  window: z.enum(["week", "month", "all"]),
};

/** Finished Tasks counted by status, owner and Project for the chosen window. */
export const loadFinishedTaskSummary = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object(finishedScope).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).finishedSummary(
      { workspaceId, userId: user.id, conversationId: data.conversationId },
      { window: data.window },
    );
  });

/** One page of finished Tasks in one status; `cursor` is the previous page's `nextCursor`. */
export const loadFinishedTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        ...finishedScope,
        status: z.enum(["done", "closed"]),
        cursor: z.string().max(100).nullable().optional(),
        owners: z.array(z.string().min(1).max(64)).max(100).optional(),
        projects: z.array(z.string().min(1).max(64)).max(100).optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const { conversationId, ...query } = data;
    return new TaskBoard(db).finishedPage({ workspaceId, userId: user.id, conversationId }, query);
  });

export const executeTask = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: TaskCommand): TaskCommand => taskCommand.parse(data))
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const result = await browserTaskBoard(db).execute({ workspaceId, userId: user.id }, data);
    if (data.operation === "claim") refuseUnclaimed(result);
    return result;
  });

/** Only an affordance: the write rechecks the actor's current role in its transaction. */
export const loadTaskAssignmentAccess = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { db, workspaceId, user } }) =>
    canAssignOther(db, workspaceId, { userId: user.id }),
  );
