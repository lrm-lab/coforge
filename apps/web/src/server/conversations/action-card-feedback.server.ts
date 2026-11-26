import {
  FEEDBACK_SUBMIT_BODY_MAX_LENGTH,
  FEEDBACK_SUBMIT_CATEGORIES,
  type FeedbackSubmitAction,
  type FeedbackSubmitCategory,
  type ResolvedFeedbackSubmitPayload,
} from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { submitUserFeedback } from "#src/server/feedback/feedback.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import { wakeCardAuthor } from "./action-card-outcome-wake.server";
import type { ActionCardView, ActionCardViewBase } from "./action-card-view.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { feedbackSubmitResultBody } from "./agent-message-view.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";

export type CommitFeedbackSubmitInput = {
  messageId: string;
  category?: FeedbackSubmitCategory;
  body?: string;
  pagePath?: string | null;
  clientInfo?: string | null;
};

function isFeedbackSubmitCategory(value: unknown): value is FeedbackSubmitCategory {
  return (
    typeof value === "string" && (FEEDBACK_SUBMIT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function resolveFeedbackSubmitPayload(
  action: FeedbackSubmitAction,
): ResolvedFeedbackSubmitPayload {
  return {
    type: "feedback:submit",
    category: action.category,
    body: action.body,
  };
}

export function feedbackSubmitActionCardView(
  base: ActionCardViewBase,
  card: { result: unknown },
  payload: ResolvedFeedbackSubmitPayload,
  pending: boolean,
): ActionCardView {
  return {
    ...base,
    kind: "feedback:submit",
    category: payload.category,
    body: payload.body,
    canCommit: pending,
    canCancel: pending,
    result: card.result as
      | { feedbackId: string; category: FeedbackSubmitCategory; body?: string }
      | undefined,
  };
}

export async function commitFeedbackSubmitCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  input: CommitFeedbackSubmitInput,
  dependencies: {
    publisher?: Pick<CentrifugoServerApi, "publishBatch">;
    submitFeedback?: typeof submitUserFeedback;
  } = {},
): Promise<{ feedbackId: string; category: FeedbackSubmitCategory; body: string }> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    input.messageId,
    "feedback:submit",
  );
  const payload = card.payload as ResolvedFeedbackSubmitPayload;
  const category = input.category ?? payload.category;
  if (!isFeedbackSubmitCategory(category)) throw new AppError("INVALID_INPUT");
  const body = (input.body ?? payload.body).trim();
  if (!body || body.length > FEEDBACK_SUBMIT_BODY_MAX_LENGTH) throw new AppError("INVALID_INPUT");

  const submitFeedback = dependencies.submitFeedback ?? submitUserFeedback;
  const submitted = await submitFeedback(db, {
    userId: principal.actorUserId,
    workspaceId: principal.workspaceId,
    category,
    body,
    pagePath: input.pagePath ?? null,
    clientInfo: input.clientInfo ?? null,
    files: [],
  });
  const result = { feedbackId: submitted.id, category, body };
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
  await wakeFeedbackAgent(db, dependencies.publisher, {
    workspaceId: principal.workspaceId,
    messageId: input.messageId,
    conversationId: card.conversationId,
    agentId: card.preparedByAgentId,
    actorUserId: principal.actorUserId,
    result,
  });
  return result;
}

function defaultPublisher(
  publisher: Pick<CentrifugoServerApi, "publishBatch"> | undefined,
): AgentDeliveryPublisher | undefined {
  if (publisher) return new AgentDeliveryPublisher(publisher);
  try {
    return new AgentDeliveryPublisher(createCentrifugoServerApi());
  } catch {
    return undefined;
  }
}

async function wakeFeedbackAgent(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "publishBatch"> | undefined,
  input: {
    workspaceId: string;
    messageId: string;
    conversationId: string;
    agentId: string;
    actorUserId: string;
    result: { feedbackId: string; category: FeedbackSubmitCategory };
  },
) {
  try {
    const actor = await db.user.findUnique({
      where: { id: input.actorUserId },
      select: { username: true },
    });
    await wakeCardAuthor(
      db,
      defaultPublisher(publisher),
      { ...input, preparedByAgentId: input.agentId },
      "choice",
      (target) =>
        feedbackSubmitResultBody(
          { result: input.result },
          target,
          actor ? { handle: actor.username } : null,
        ),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "action_card_feedback_wake_failed",
        messageId: input.messageId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
