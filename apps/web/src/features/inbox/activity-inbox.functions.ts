import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { browserActivityInbox } from "#src/server/inbox/browser-activity-inbox.server";
import { waitingChoiceCards } from "#src/server/conversations/waiting-choice-cards.server";
import {
  activityDoneUndoSchema,
  activityInboxPageSchema,
  activityInboxReadAllSchema,
  activityItemDoneSchema,
  activityItemReadSchema,
  activityMentionReadSchema,
} from "./activity-inbox.schemas";

export const loadActivityInbox = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxPageSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    const { streamPositions, data: page } = await readAfterStreamPositions(
      data.cursor ? [] : [userConversationChannel(user.id)],
      () => browserActivityInbox(db).list(workspaceId, user.id, data),
    );
    return { ...page, streamPositions };
  });

export const loadWaitingChoiceCards = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { db, workspaceId, user } = context;
    return waitingChoiceCards(db, workspaceId, user.id);
  });

export const markActivityItemDone = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityItemDoneSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).markDone(workspaceId, user.id, data);
  });

export const markActivityItemRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityItemReadSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).markArtifactRead(workspaceId, user.id, data);
  });

export const markActivityAllDone = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxReadAllSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    return browserActivityInbox(db).markAllDone(workspaceId, user.id, {
      before: new Date(data.before),
    });
  });

export const undoActivityDone = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityDoneUndoSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).undoDone(workspaceId, user.id, data);
  });

export const markActivityInboxRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxReadAllSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await browserActivityInbox(db).markAllRead(workspaceId, user.id, {
      before: new Date(data.before),
    });
  });

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
