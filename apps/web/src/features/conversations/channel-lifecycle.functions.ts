import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { isAppErrorCode } from "#src/lib/app-error";
import { ChannelAgentControl } from "#src/server/conversations/channel-agent-control.server";
import { CHANNEL_AGENT_GUIDANCE_MAX_LENGTH } from "#src/lib/channel-agent-guidance";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { userAgentControl } from "#src/server/agents/user-agent-control.server";
import { channelInput, channelScope } from "./channel-function-scope.server";

/* A channel's life as a whole, for its settings and Settings: archiving, hiding #general,
 * stopping and resuming its Agents, deleting it. */

export const setPublicChannelArchived = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ archived: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setArchived(workspaceId, { userId }, data.channelId, data.archived);
  });

/** Whether `#general` is hidden from the whole Workspace, for the System channels section of
 * Settings → Members; `null` for anyone but a Workspace owner or admin (or a Workspace without
 * #general), who get no such section. */
export const loadGeneralChannelHidden = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<{ hidden: boolean } | null> => {
    const { channels, workspaceId, userId } = channelScope(context);
    try {
      return { hidden: await channels.generalHidden(workspaceId, userId) };
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED", "NOT_FOUND")) return null;
      throw error;
    }
  });

/** The Workspace's archived channels for Settings → Workspace profile, newest archive first;
 * `null` for anyone but a Workspace owner or admin, who may not unarchive them there. */
export const loadArchivedChannels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    try {
      return await channels.archived(workspaceId, userId);
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) return null;
      throw error;
    }
  });

/** Hides `#general` from the whole Workspace, or restores it (owner/admin only). */
export const setGeneralChannelHidden = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ hidden: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setGeneralHidden(workspaceId, userId, data.hidden);
  });

function channelAgents(db: WorkspaceUserContext["db"]) {
  return new ChannelAgentControl(db, userAgentControl(db), getComputerStatusCache());
}

export const resumeChannelAgents = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ guidance: z.string().max(CHANNEL_AGENT_GUIDANCE_MAX_LENGTH) }))
  .handler(async ({ data, context }) => {
    const { db, workspaceId, userId } = channelScope(context);
    return channelAgents(db).resumeAll(workspaceId, userId, data.channelId, data.guidance);
  });

export const stopChannelAgents = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { db, workspaceId, userId } = channelScope(context);
    return channelAgents(db).stopAll(workspaceId, userId, data.channelId);
  });

export const deletePublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.deleteChannel(workspaceId, userId, data.channelId);
  });
