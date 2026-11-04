import { isAppError } from "#src/lib/app-error";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type { PublicChannelPorts } from "./channel-access.server";
import { addChannelMembers } from "./channel-roster.server";
import {
  announceNotifiedPeople,
  claimMentionActions,
  notifyMentionTargets,
  releaseMentionActions,
  type MentionActionResult,
} from "./pending-mention-actions.server";
import { publishNonMemberDeliveries } from "./non-member-deliveries.server";

/**
 * The sender acts on mentions of their messages that did not reach their target: `notify` has
 * each target read that one message (see `notifyMentionTargets`); `add` makes each target a
 * member of the channel it was mentioned in, under the sender's own authority to add members.
 * Results come back in request order, one per distinct resolution id.
 */
export async function executeMentionActions(
  ports: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  action: "notify" | "add",
  resolutionIds: readonly string[],
): Promise<MentionActionResult[]> {
  const { db, realtime, publisher } = ports;
  await requireWorkspaceMember(db, workspaceId, userId);
  if (action === "notify") {
    const { results, deliveries, notifiedUserIds } = await notifyMentionTargets(
      db,
      workspaceId,
      { userId },
      resolutionIds,
    );
    await publishNonMemberDeliveries(
      db,
      publisher ?? createCentrifugoServerApi(),
      workspaceId,
      deliveries,
    );
    await announceNotifiedPeople(realtime, workspaceId, notifiedUserIds);
    return results;
  }
  const { refused, claimed } = await claimMentionActions(
    db,
    workspaceId,
    { userId },
    resolutionIds,
  );
  const results = new Map(refused.map((result) => [result.resolutionId, result]));
  const byChannel = new Map<string, typeof claimed>();
  for (const claim of claimed)
    byChannel.set(claim.conversationId, [...(byChannel.get(claim.conversationId) ?? []), claim]);
  for (const [channelId, claims] of byChannel) {
    try {
      await addChannelMembers(ports, workspaceId, { userId }, channelId, {
        userIds: claims.flatMap((claim) => (claim.targetType === "user" ? [claim.targetId] : [])),
        agentIds: claims.flatMap((claim) => (claim.targetType === "agent" ? [claim.targetId] : [])),
      });
      for (const claim of claims)
        results.set(claim.resolutionId, {
          resolutionId: claim.resolutionId,
          status: "delivered",
          targetType: claim.targetType,
          targetId: claim.targetId,
          targetHandle: claim.targetHandle,
        });
    } catch (error) {
      await releaseMentionActions(db, claims);
      if (!isAppError(error)) throw error;
      for (const claim of claims)
        results.set(claim.resolutionId, {
          resolutionId: claim.resolutionId,
          status: "no_permission",
          reason: "could_not_apply",
          targetType: claim.targetType,
          targetId: claim.targetId,
          targetHandle: claim.targetHandle,
        });
    }
  }
  return [...new Set(resolutionIds)].map((id) => results.get(id)!);
}
