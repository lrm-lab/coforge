import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

// A member marks a channel unread, or closes it, in their own sidebar. Nobody else's sidebar
// changes.

const channelInput = z.object({ channelId: z.uuid() });

function channelScope({ db, workspaceId, user }: WorkspaceUserContext) {
  return { channels: new PublicChannels(db), workspaceId, userId: user.id };
}

/** Marks the conversation unread for this member, or clears the marker (#122). */
export const setPublicConversationUnread = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ unread: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserUnread(workspaceId, userId, data.channelId, data.unread);
  });

/** Closes (hides) the conversation for this member only, or brings it back (#122). */
export const setPublicConversationHidden = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ hidden: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserHidden(workspaceId, userId, data.channelId, data.hidden);
  });
