import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { listChannelThreadUnreads as readChannelThreadUnreads } from "#src/server/conversations/channel-thread-unread.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

// A member's place in a channel's threads: read, followed, and the Agents following one.

const channelInput = z.object({ channelId: z.uuid() });

function channelScope({ db, workspaceId, user }: WorkspaceUserContext) {
  return { channels: new PublicChannels(db), workspaceId, userId: user.id };
}
const channelThreadReadInput = channelInput.extend({
  threadRootId: z.uuid(),
  throughSequence: z.number().int().positive(),
});
const channelThreadFollowInput = channelInput.extend({
  threadRootId: z.uuid(),
  followed: z.boolean(),
});

export const channelThreadUnreadsInput = z.object({
  workspaceId: z.uuid(),
  conversationIds: z.array(z.uuid()).max(100),
});

export const listChannelThreadUnreads = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadUnreadsInput)
  .handler(({ data, context }) => {
    if (data.workspaceId !== context.workspaceId) throw new AppError("ACCESS_DENIED");
    return readChannelThreadUnreads(
      context.db,
      context.workspaceId,
      context.user.id,
      data.conversationIds,
    );
  });

export const markPublicChannelThreadRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadReadInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.markThreadReadForUser(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const setPublicChannelThreadFollowed = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadFollowInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserThreadFollowed(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.followed,
    );
  });

const channelThreadAgentsInput = channelInput.extend({ threadRootId: z.uuid() });

export const loadPublicChannelThreadFollowingAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadAgentsInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.threadFollowingAgents(workspaceId, userId, data.channelId, data.threadRootId);
  });

export const unfollowPublicChannelThreadAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadAgentsInput.extend({ agentId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.unfollowAgentFromThread(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.agentId,
    );
  });
