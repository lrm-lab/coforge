import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { browserActivityInbox } from "#src/server/inbox/browser-activity-inbox.server";
import {
  activityInboxPageSchema,
  activityInboxReadAllSchema,
  activityItemDoneSchema,
  activityMentionReadSchema,
} from "./activity-inbox.schemas";

/** One page of the viewer's Activity inbox, newest activity first, with the view's totals; the
 * first page with where it was read in the viewer's own channel. */
export const loadActivityInbox = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxPageSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    const { streamPositions, data: page } = await readAfterStreamPositions(
      data.offset ? [] : [userConversationChannel(user.id)],
      () => browserActivityInbox(db).list(workspaceId, user.id, data),
    );
    return { ...page, streamPositions };
  });

/** Marks one item Done (and read) through the newest message the viewer saw in it. */
export const markActivityItemDone = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityItemDoneSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).markDone(workspaceId, user.id, data);
  });

/** Reads every joined conversation and listed thread up to when the viewer's list was loaded;
 * items stay listed. */
export const markActivityInboxRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxReadAllSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).markAllRead(workspaceId, user.id, {
      before: new Date(data.before),
    });
  });

/** Whether the viewer has unread activity, for the nav rail's Activity dot, with where it was read
 * in the viewer's own channel, which carries every message that lights it. */
export const loadActivityNavAttention = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { db, workspaceId, user } = context;
    const { streamPositions, data } = await readAfterStreamPositions(
      [userConversationChannel(user.id)],
      () => browserActivityInbox(db).navAttention(workspaceId, user.id),
    );
    return { ...data, streamPositions };
  });

/** Reads or unreads a mention the viewer was notified of; it stays listed until Done. */
export const setActivityMentionRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityMentionReadSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).setMentionRead(
      workspaceId,
      user.id,
      data.resolutionId,
      data.read,
    );
  });
