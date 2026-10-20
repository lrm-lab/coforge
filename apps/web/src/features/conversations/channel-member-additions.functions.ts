import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { addMembersReportingRefusals } from "#src/server/conversations/channel-member-additions.server";

/** The channel settings' add view: the picked people and Agents that can join do; the ones that
 * cannot come back in `failed` beside the fresh roster (`members`). A refusal of the channel itself
 * (archived, the viewer not a member) still rejects the whole request. */
export const addPublicChannelMembersReportingRefusals = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      channelId: z.uuid(),
      userIds: z.array(z.uuid()).default([]),
      agentIds: z.array(z.uuid()).default([]),
    }),
  )
  .handler(async ({ data, context }) =>
    addMembersReportingRefusals(
      new PublicChannels(context.db),
      context.workspaceId,
      { userId: context.user.id },
      data.channelId,
      { userIds: data.userIds, agentIds: data.agentIds },
    ),
  );
