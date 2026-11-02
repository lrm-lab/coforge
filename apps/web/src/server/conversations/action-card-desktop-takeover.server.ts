import type { DesktopTakeoverAction, ResolvedDesktopTakeoverPayload } from "@lrm/coforge-sdk/agent";
import type { ActionCardView, ActionCardViewBase } from "./action-card-view.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ActionCardError } from "./action-card-error.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";

export function desktopTakeoverActionCardView(
  base: ActionCardViewBase,
  card: { preparedByAgent: { ownerId: string }; result: unknown },
  payload: ResolvedDesktopTakeoverPayload,
  viewerUserId: string,
  pending: boolean,
): ActionCardView {
  return {
    ...base,
    kind: "desktop:takeover",
    prompt: payload.prompt,
    computerId: payload.computerId,
    agentId: payload.agentId,
    agentName: payload.agentName,
    canCommit: pending && card.preparedByAgent.ownerId === viewerUserId,
    result: card.result as { done: true } | undefined,
  };
}

export async function resolveDesktopTakeoverPayload(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  action: DesktopTakeoverAction,
): Promise<ResolvedDesktopTakeoverPayload> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { computerId: true, name: true, displayName: true },
  });
  if (!agent?.computerId) {
    throw new ActionCardError(422, "INVALID_ACTION", "this agent has no cloud computer");
  }
  return {
    type: "desktop:takeover",
    ...(action.prompt ? { prompt: action.prompt } : {}),
    agentId,
    computerId: agent.computerId,
    agentName: agent.displayName || agent.name,
  };
}

/** Marks that the person finished the desktop step. Opening the desktop is client-side only. */
export async function commitDesktopTakeoverCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  messageId: string,
): Promise<{ done: true }> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    messageId,
    "desktop:takeover",
  );
  if (card.preparedByAgent.ownerId !== principal.actorUserId) throw new AppError("ACCESS_DENIED");
  const result = { done: true as const };
  const updated = await db.actionCard.updateMany({
    where: { messageId, state: "pending" },
    data: {
      state: "executed",
      committedByUserId: principal.actorUserId,
      committedAt: new Date(),
      result: result as unknown as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new AppError("CONFLICT");
  await publishActionCardUpdate(db, realtime, card.conversationId, messageId);
  return result;
}
