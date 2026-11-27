import type { PrismaClient } from "#src/generated/prisma/client";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { isAppErrorCode } from "#src/lib/app-error";
import { agentChannelInfo, type AgentChannelInfo } from "./agent-channel-reads.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
  visibilityDeniedError,
} from "./agent-channel-management-error.server";
import { normalizeChannelName, parseChannelTarget } from "./agent-channel-targets.server";
import type { ChannelActor } from "./channel-actor.server";
import {
  canChangeChannelVisibility,
  hasChannelAdminAuthority,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import type { PublicChannels } from "./public-channels.server";

export async function updateAgentChannel(
  ports: { db: PrismaClient; channels: PublicChannels },
  workspaceId: string,
  actor: ChannelActor,
  target: string,
  patch: { name?: string; description?: string; visibility?: ChannelVisibility },
): Promise<AgentChannelInfo> {
  const changesInfo = patch.name !== undefined || patch.description !== undefined;
  if (!changesInfo && patch.visibility === undefined)
    throw new AgentChannelManagementError(
      400,
      "update requires --name, --description, --public or --private",
    );
  const channelName = parseChannelTarget(target);
  const channel = await ports.db.conversation.findFirst({
    where: { ...visibleChannelWhere(workspaceId, actor), channelName },
  });
  if (!channel) throw new AgentChannelManagementError(404, "channel not found");
  if (changesInfo && !(await hasChannelAdminAuthority(ports.db, workspaceId, actor, channel)))
    throw channelAuthorityDeniedError("update");
  if (patch.visibility !== undefined) {
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "#general is always public");
    const authority = await resolveChannelAuthority(ports.db, workspaceId, actor, channel);
    if (!canChangeChannelVisibility(channelName, authority.serverRole, authority.isActiveMember))
      throw visibilityDeniedError();
  }
  if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
  let nextName: string | undefined;
  if (patch.name !== undefined) {
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot rename #general");
    nextName = normalizeChannelName(patch.name);
    if (nextName === "general") throw new AgentChannelManagementError(409, "general is reserved");
  }
  if (changesInfo)
    try {
      await ports.channels.updateInfo(workspaceId, actor, channel.id, {
        name: nextName,
        description: patch.description,
      });
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw channelAuthorityDeniedError("update");
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
  if (patch.visibility !== undefined)
    try {
      await ports.channels.setVisibility(workspaceId, actor, channel.id, patch.visibility);
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) throw visibilityDeniedError();
      if (isAppErrorCode(error, "CONFLICT"))
        throw new AgentChannelManagementError(409, "channel is archived");
      if (isAppErrorCode(error, "NOT_FOUND"))
        throw new AgentChannelManagementError(404, "channel not found");
      throw error;
    }
  const refreshed = await ports.db.conversation.findFirst({
    where: { ...visibleChannelWhere(workspaceId, actor), channelName: nextName ?? channelName },
  });
  if (!refreshed) throw new AgentChannelManagementError(404, "channel not found");
  return agentChannelInfo(ports.db, workspaceId, refreshed, actor);
}
