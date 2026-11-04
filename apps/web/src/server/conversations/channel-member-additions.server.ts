import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { partitionAddableChannelMembers } from "./channel-member-checks.server";
import type { PublicChannels } from "./public-channels.server";
import type { ChannelActor } from "./channel-actor.server";

/** Why one picked person or Agent did not join: a stable code, never shown verbatim. */
export type MemberAdditionFailure = {
  kind: "user" | "agent";
  id: string;
  reason: "not_in_workspace" | "agent_inactive" | "agent_private";
};

/**
 * Adds the picked people and Agents through `PublicChannels.addMembers`, reporting each one that
 * cannot join instead of failing the rest (the channel settings' add view). The whole batch goes
 * in one call first; only when that call refuses a target (INVALID_INPUT) are the unaddable
 * targets partitioned out and the addable set added in one call, so one action posts at most one
 * membership record. Any other error, such as a refusal of the channel itself (archived, the
 * actor not an active member, no such channel), rejects the request. `addMembers` stays
 * all-or-nothing for its other callers (the Agent CLI, channel creation, action cards). Returns
 * the fresh roster with the failures.
 */
export async function addMembersReportingRefusals(
  db: PrismaClient,
  channels: PublicChannels,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  input: { userIds: string[]; agentIds: string[] },
) {
  const userIds = [...new Set(input.userIds)];
  const agentIds = [...new Set(input.agentIds)];
  try {
    const members = await channels.addMembers(workspaceId, actor, channelId, { userIds, agentIds });
    return { members, failed: [] };
  } catch (error) {
    if (!isAppErrorCode(error, "INVALID_INPUT")) throw error;
  }

  const { addable, refused } = await partitionAddableChannelMembers(db, workspaceId, {
    userIds,
    agentIds,
  });
  const members =
    addable.userIds.length + addable.agentIds.length
      ? await channels.addMembers(workspaceId, actor, channelId, addable)
      : // Nothing to add: the roster still comes back for the view.
        await channels.members(workspaceId, actor, channelId);
  return { members, failed: refused };
}
