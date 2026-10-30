import type { PrismaClient } from "#src/generated/prisma/client";
import { canJoinChannel } from "./mention-target-availability.server";
import {
  pendingMentionActionsForActor,
  targetMembership,
  type MentionActor,
  type TargetMembership,
} from "./pending-mention-views.server";
import { publishNonMemberDeliveries, type NonMemberDelivery } from "./non-member-deliveries.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

/** The outcome of one requested mention action: `delivered` when the target was added, `queued`
 * when it was notified. */
export type MentionActionResult = {
  resolutionId: string;
  status: "delivered" | "queued" | "stale" | "expired" | "no_permission" | "not_found";
  reason?:
    | "no_longer_pending"
    | "target_already_member"
    | "target_unavailable"
    | "sender_lacks_channel_access"
    | "channel_archived"
    | "could_not_apply"
    | "add_requires_human_member_authority"
    | "already_queued";
  targetType?: "user" | "agent";
  targetId?: string;
  /** The `@handle` the sender wrote, without the `@`. */
  targetHandle?: string;
};

/** One pending mention the sender may act on now, claimed for that action. */
export type ClaimedMentionAction = {
  resolutionId: string;
  conversationId: string;
  targetType: "user" | "agent";
  targetId: string;
  targetHandle: string;
};

/** Each requested row the sender owns, with what deciding and carrying out an action needs. */
async function loadActionRows(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  sender: MentionActor,
  ids: readonly string[],
) {
  const rows = await db.pendingMentionAction.findMany({
    where: {
      id: { in: [...ids] },
      workspaceId,
      sender: "userId" in sender ? { userId: sender.userId } : { agentId: sender.agentId },
    },
    select: {
      id: true,
      messageId: true,
      conversationId: true,
      targetUserId: true,
      targetAgentId: true,
      targetHandle: true,
      expiresAt: true,
      resolvedAt: true,
      notifiedAt: true,
      sender: { select: { leftAt: true } },
      message: { select: { sequence: true, conversation: { select: { archivedAt: true } } } },
      targetAgent: { select: { visibility: true, deletedAt: true } },
      targetUser: { select: { memberships: { where: { workspaceId }, select: { userId: true } } } },
    },
  });
  return {
    byId: new Map(rows.map((row) => [row.id, row])),
    membership: await targetMembership(db, rows),
  };
}

type ActionRow = NonNullable<ReturnType<Awaited<ReturnType<typeof loadActionRows>>["byId"]["get"]>>;

function actionTarget(row: Pick<ActionRow, "targetAgentId" | "targetUserId" | "targetHandle">) {
  return {
    targetType: row.targetAgentId ? ("agent" as const) : ("user" as const),
    targetId: (row.targetAgentId ?? row.targetUserId)!,
    targetHandle: row.targetHandle,
  };
}

/** Why an action on this row cannot be taken now, or `undefined` when it can. The same rules for
 * Notify and Add. */
function actionRefusal(
  row: ActionRow,
  membership: TargetMembership,
  now: Date,
): Pick<MentionActionResult, "status" | "reason"> | undefined {
  if (row.resolvedAt) return { status: "stale", reason: "no_longer_pending" };
  if (row.expiresAt <= now) return { status: "expired" };
  if (row.sender.leftAt) return { status: "no_permission", reason: "sender_lacks_channel_access" };
  if (row.message.conversation.archivedAt)
    return { status: "no_permission", reason: "channel_archived" };
  if (!canJoinChannel(row)) return { status: "stale", reason: "target_unavailable" };
  if (membership.has(row.conversationId, actionTarget(row).targetId))
    return { status: "stale", reason: "target_already_member" };
  return undefined;
}

/**
 * Checks each requested resolution id against its row and claims the ones the sender can add now,
 * so a concurrent or repeated request never adds the same target twice. A row that is not this
 * sender's is `not_found`, exactly like one that does not exist. The refusals come back as results;
 * the claimed rows are for the caller to carry out, and to `releaseMentionActions` if it cannot.
 */
export async function claimMentionActions(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  sender: MentionActor,
  resolutionIds: readonly string[],
  now: Date = new Date(),
): Promise<{ refused: MentionActionResult[]; claimed: ClaimedMentionAction[] }> {
  const ids = [...new Set(resolutionIds)];
  const { byId, membership } = await loadActionRows(db, workspaceId, sender, ids);
  const refused: MentionActionResult[] = [];
  const claimed: ClaimedMentionAction[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      refused.push({ resolutionId: id, status: "not_found" });
      continue;
    }
    const target = actionTarget(row);
    const refusal = actionRefusal(row, membership, now);
    if (refusal) {
      refused.push({ resolutionId: id, ...refusal, ...target });
      continue;
    }
    // Claimed only while still pending: a concurrent request that got here first wins.
    const { count } = await db.pendingMentionAction.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: now, resolvedAction: "add" },
    });
    if (count) claimed.push({ resolutionId: id, conversationId: row.conversationId, ...target });
    else
      refused.push({ resolutionId: id, status: "stale", reason: "no_longer_pending", ...target });
  }
  return { refused, claimed };
}

/**
 * Notify a target of this message only, without channel access: Agents get a non-member
 * delivery, humans an Activity item. Keep the action pending for later add; repeat notify
 * is queued/already_queued. Return ordered results and deliveries for publication.
 */
export async function notifyMentionTargets(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember" | "agentMessageDelivery">,
  workspaceId: string,
  sender: MentionActor,
  resolutionIds: readonly string[],
  now: Date = new Date(),
): Promise<{
  results: MentionActionResult[];
  deliveries: NonMemberDelivery[];
  /** People newly notified, whose Activity inbox changed. */
  notifiedUserIds: string[];
}> {
  const ids = [...new Set(resolutionIds)];
  const { byId, membership } = await loadActionRows(db, workspaceId, sender, ids);
  const results: MentionActionResult[] = [];
  const deliveries: NonMemberDelivery[] = [];
  const notifiedUserIds = new Set<string>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      results.push({ resolutionId: id, status: "not_found" });
      continue;
    }
    const target = actionTarget(row);
    const refusal = actionRefusal(row, membership, now);
    if (refusal) {
      results.push({ resolutionId: id, ...refusal, ...target });
      continue;
    }
    // The Agent's delivery exists before the mention reads as notified, so a failure in between
    // leaves it pending and a retry delivers; the delivery itself is written once per message.
    const delivery = row.targetAgentId
      ? await db.agentMessageDelivery.upsert({
          where: { messageId_agentId: { messageId: row.messageId, agentId: row.targetAgentId } },
          create: {
            messageId: row.messageId,
            agentId: row.targetAgentId,
            workspaceId,
            conversationId: row.conversationId,
            sequence: row.message.sequence,
          },
          update: {},
          select: { deliveryId: true },
        })
      : undefined;
    // Notified only once: a concurrent or repeated request finds it already queued.
    const { count } = await db.pendingMentionAction.updateMany({
      where: { id, resolvedAt: null, notifiedAt: null },
      data: { notifiedAt: now },
    });
    if (!count) {
      results.push({ resolutionId: id, status: "queued", reason: "already_queued", ...target });
      continue;
    }
    if (delivery && row.targetAgentId)
      deliveries.push({
        deliveryId: delivery.deliveryId,
        agentId: row.targetAgentId,
        messageId: row.messageId,
      });
    if (row.targetUserId) notifiedUserIds.add(row.targetUserId);
    results.push({ resolutionId: id, status: "queued", ...target });
  }
  return { results, deliveries, notifiedUserIds: [...notifiedUserIds] };
}

/** Puts claimed actions back to pending when the caller could not carry them out. */
export async function releaseMentionActions(
  db: Pick<PrismaClient, "pendingMentionAction">,
  claimed: readonly ClaimedMentionAction[],
): Promise<void> {
  await db.pendingMentionAction.updateMany({
    where: { id: { in: claimed.map((action) => action.resolutionId) } },
    data: { resolvedAt: null, resolvedAction: null },
  });
}

/**
 * An Agent's still-pending mention actions across every channel it sent in: not acted on and not
 * expired, oldest message first and, within a message, in the order its body names them, each with
 * what it still allows.
 */
export function pendingMentionActionsForAgent(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  agentId: string,
  now = new Date(),
) {
  return pendingMentionActionsForActor(db, workspaceId, { agentId }, now);
}

/**
 * An Agent's request to add the targets of its pending mentions. Adding a member is a human's
 * decision, so each of the Agent's own mentions is refused with that reason; an id that is not the
 * Agent's is `not_found`. Results in request order, one per distinct id.
 */
export async function refuseAgentMentionAdds(
  db: Pick<PrismaClient, "pendingMentionAction">,
  workspaceId: string,
  agentId: string,
  resolutionIds: readonly string[],
): Promise<MentionActionResult[]> {
  const ids = [...new Set(resolutionIds)];
  const rows = await db.pendingMentionAction.findMany({
    where: { id: { in: ids }, workspaceId, sender: { agentId } },
    select: { id: true, targetUserId: true, targetAgentId: true, targetHandle: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id): MentionActionResult => {
    const row = byId.get(id);
    if (!row) return { resolutionId: id, status: "not_found" };
    return {
      resolutionId: id,
      status: "no_permission",
      reason: "add_requires_human_member_authority",
      ...actionTarget(row),
    };
  });
}

/** Tells each newly notified person's open Activity page and nav dot to re-read. Best effort: the
 * next read shows the item anyway. */
export async function announceNotifiedPeople(
  realtime: Pick<ConversationRealtime, "activityChanged"> | undefined,
  workspaceId: string,
  userIds: readonly string[],
): Promise<void> {
  await Promise.all(
    userIds.map((userId) =>
      (realtime?.activityChanged?.({ workspaceId, userId }) ?? Promise.resolve()).catch(() => {}),
    ),
  );
}

/** An Agent notifies the targets of its own pending mentions: see `notifyMentionTargets`. */
export async function notifyAgentMentionTargets(
  db: Pick<
    PrismaClient,
    | "pendingMentionAction"
    | "conversationMember"
    | "agentMessageDelivery"
    | "message"
    | "$queryRaw"
    | "$transaction"
  >,
  workspaceId: string,
  agentId: string,
  resolutionIds: readonly string[],
  publisher: CentrifugoServerApi = createCentrifugoServerApi(),
): Promise<MentionActionResult[]> {
  const { results, deliveries, notifiedUserIds } = await notifyMentionTargets(
    db,
    workspaceId,
    { agentId },
    resolutionIds,
  );
  await publishNonMemberDeliveries(db, publisher, workspaceId, deliveries);
  await announceNotifiedPeople(
    new CentrifugoConversationRealtime(publisher),
    workspaceId,
    notifiedUserIds,
  );
  return results;
}
