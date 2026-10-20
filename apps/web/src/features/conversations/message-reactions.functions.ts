import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readMessageReactions } from "#src/server/conversations/message-reaction-reads.server";
import {
  toggleChannelReaction,
  toggleDirectReaction,
} from "#src/server/conversations/reaction-toggles.server";
import {
  directConversationInputSchema,
  toggleMessageReactionInputSchema,
} from "./conversation.schemas";

/** The current reactions and `reactionVersion` of loaded messages of one conversation, for a page
 * that lost `message.reaction.v1` events (`reaction-sync.ts`). A POST: 200 ids would make too
 * long a query string. */
export const loadMessageReactions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid(), messageIds: z.array(z.uuid()).max(200) }))
  .handler(({ data, context: { db, workspaceId, user } }) =>
    readMessageReactions(db, { workspaceId, userId: user.id, ...data }),
  );

/** The viewer's own emoji reaction on a channel message; returns the message's fresh summaries
 * with their version. (`toggleChannelMessageReaction` stays for tabs opened before versions.) */
export const toggleChannelMessageReactionVersioned = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ channelId: z.uuid() }).extend(toggleMessageReactionInputSchema.shape))
  .handler(({ data, context }) => toggleChannelReaction(context, data));

/** The same for a DM message (`toggleDirectMessageReaction` stays for older tabs). */
export const toggleDirectMessageReactionVersioned = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend(toggleMessageReactionInputSchema.shape))
  .handler(({ data, context }) => toggleDirectReaction(context, data));
