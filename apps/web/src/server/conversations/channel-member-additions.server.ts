import { isAppErrorCode } from "#src/lib/app-error";
import type { ChannelActor, PublicChannels } from "./public-channels.server";

/** Why one picked person or Agent did not join: a stable code, never shown verbatim. */
export type MemberAdditionFailure = {
  kind: "user" | "agent";
  id: string;
  reason: "not_in_workspace" | "agent_inactive" | "agent_private";
};

/**
 * Adds the picked people and Agents through `PublicChannels.addMembers`, reporting each one that
 * cannot join instead of failing the rest (the channel settings' add view). The whole batch goes
 * in one call first; only when that call refuses a target (INVALID_INPUT) does each target go on
 * its own, and only INVALID_INPUT counts as that target's refusal. Any other error, such as a
 * refusal of the channel itself (archived, the actor not an active member, no such channel),
 * rejects the request. `addMembers` stays all-or-nothing for its other callers (the Agent CLI,
 * channel creation, action cards). Returns the fresh roster with the failures.
 */
export async function addMembersReportingRefusals(
  channels: PublicChannels,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  input: { userIds: string[]; agentIds: string[] },
) {
  const userIds = [...new Set(input.userIds)];
  const agentIds = [...new Set(input.agentIds)];
  const failed: MemberAdditionFailure[] = [];
  try {
    const members = await channels.addMembers(workspaceId, actor, channelId, { userIds, agentIds });
    return { members, failed };
  } catch (error) {
    if (!isAppErrorCode(error, "INVALID_INPUT")) throw error;
  }

  const targets = [
    ...userIds.map((id) => ({ kind: "user" as const, id })),
    ...agentIds.map((id) => ({ kind: "agent" as const, id })),
  ];
  // `addMembers` returns the fresh roster (beside who already belonged); keep the last one.
  let members: Awaited<ReturnType<PublicChannels["members"]>> | undefined;
  for (const target of targets) {
    try {
      members = await channels.addMembers(workspaceId, actor, channelId, {
        userIds: target.kind === "user" ? [target.id] : [],
        agentIds: target.kind === "agent" ? [target.id] : [],
      });
    } catch (error) {
      if (!isAppErrorCode(error, "INVALID_INPUT")) throw error;
      failed.push({ ...target, reason: refusalReason(target.kind, error.errorId) });
    }
  }
  // The last successful call already read the roster; read it here only if every pick failed.
  return { members: members ?? (await channels.members(workspaceId, actor, channelId)), failed };
}

function refusalReason(
  kind: MemberAdditionFailure["kind"],
  errorId: string | undefined,
): MemberAdditionFailure["reason"] {
  if (kind === "user") return "not_in_workspace";
  return errorId === "agent-private" ? "agent_private" : "agent_inactive";
}
