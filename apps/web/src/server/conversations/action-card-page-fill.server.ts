import type { PageFillAction, ResolvedPageFillPayload } from "@lrm/coforge-sdk/agent";
import type { ActionCardView, ActionCardViewBase } from "./action-card-view.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ActionCardError } from "./action-card-error.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";
import { postPageFill } from "./page-fill.server";

export function pageFillActionCardView(
  base: ActionCardViewBase,
  card: { preparedByAgent: { ownerId: string }; result: unknown },
  payload: ResolvedPageFillPayload,
  viewerUserId: string,
  pending: boolean,
): ActionCardView {
  return {
    ...base,
    kind: "page:fill",
    prompt: payload.prompt,
    fields: payload.fields.map((field) => ({
      id: field.id,
      label: field.label,
      input: field.input,
    })),
    canCommit: pending && card.preparedByAgent.ownerId === viewerUserId,
    result: card.result as { filled: string[] } | undefined,
  };
}

export async function resolvePageFillPayload(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  action: PageFillAction,
): Promise<ResolvedPageFillPayload> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { computerId: true },
  });
  if (!agent?.computerId) {
    throw new ActionCardError(422, "INVALID_ACTION", "this agent has no cloud computer");
  }
  return {
    type: "page:fill",
    ...(action.prompt ? { prompt: action.prompt } : {}),
    agentId,
    fields: action.fields.map((field) => ({
      id: field.id,
      label: field.label,
      input: field.input,
      selector: field.selector,
    })),
  };
}

/** Types values into the Agent browser, then marks the card executed. The stored result is field ids only. */
export async function commitPageFillCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  input: { messageId: string; values: Record<string, string>; cookie: string },
): Promise<{ filled: string[] }> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    input.messageId,
    "page:fill",
  );
  if (card.preparedByAgent.ownerId !== principal.actorUserId) throw new AppError("ACCESS_DENIED");
  const payload = card.payload as ResolvedPageFillPayload;
  const agent = await db.agent.findFirst({
    where: {
      id: card.preparedByAgentId,
      workspaceId: principal.workspaceId,
      ...ACTIVE_AGENT_WHERE,
    },
    select: { computerId: true },
  });
  const origin = process.env.COFORGE_CLOUD_DESKTOP_ORIGIN?.trim() ?? "";
  if (!agent?.computerId || !origin) {
    throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "page-fill-desktop" });
  }
  const result = await postPageFill({
    origin,
    computerId: agent.computerId,
    agentId: card.preparedByAgentId,
    fields: payload.fields,
    values: input.values,
    cookie: input.cookie,
  });
  const updated = await db.actionCard.updateMany({
    where: { messageId: input.messageId, state: "pending" },
    data: {
      state: "executed",
      committedByUserId: principal.actorUserId,
      committedAt: new Date(),
      result: result as unknown as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new AppError("CONFLICT");
  await publishActionCardUpdate(db, realtime, card.conversationId, input.messageId);
  return result;
}
