import {
  CHOICE_OTHER_DEFAULT_LABEL,
  CHOICE_OTHER_OPTION_ID,
  CHOICE_OTHER_TEXT_MAX_LENGTH,
  type ChoiceAction,
  type ResolvedChoicePayload,
} from "@lrm/coforge-sdk/agent";
import type {
  ActionCardPersonRef,
  ActionCardView,
  ActionCardViewBase,
} from "./action-card-view.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { fenceUserText } from "./agent-message-view.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";
import {
  conversationTarget,
  deliveryTarget,
  TARGET_CONVERSATION_SELECT,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The choice card's payload, with `to` resolved to the asked person's user id: they must be in
 * the conversation the card is posted in. `legacyOwnerUserId` is the preparing Agent's owner, for
 * a card from a Computer whose CLI predates `to`: that CLI's schema strips the field, so the
 * request arrives without one, and the card asks the owner as it did before `to` existed. The
 * owner is checked like any other target, so a card in a conversation they cannot read is refused
 * rather than left impossible to answer. The fallback goes away when no supported Computer is
 * older than the release that added `to`. */
export async function resolveChoicePayload(
  db: Pick<PrismaClient, "user" | "conversationMember">,
  conversationId: string,
  action: ChoiceAction,
  legacyOwnerUserId?: string,
): Promise<ResolvedChoicePayload> {
  const asked = action.to?.trim() ?? legacyOwnerUserId;
  if (!asked)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_choice_to",
      hint: "a choice card must name who it asks: set `to` to their handle or user id",
    });
  const handle = asked.replace(/^@/, "");
  const user = await db.user.findFirst({
    where: USER_ID.test(handle) ? { id: handle } : { username: handle },
    select: { id: true },
  });
  if (!user)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_choice_to",
      hint: "the person to ask does not exist",
    });
  const member = await db.conversationMember.findFirst({
    where: { conversationId, userId: user.id, leftAt: null },
    select: { id: true },
  });
  if (!member)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_choice_to",
      hint: "the person to ask is not in this conversation",
    });
  const recommended = action.options.filter((option) => option.recommended === true);
  if (recommended.length > 1)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_choice_recommended",
      hint: "a choice card marks at most one option recommended",
    });
  const options = action.options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.recommended === true ? { recommended: true as const } : {}),
  }));
  // A recommendation is shown first: moved with a note rather than refused.
  const at = options.findIndex((option) => option.recommended === true);
  const moved = at > 0 ? options.splice(at, 1)[0]! : undefined;
  if (moved) options.unshift(moved);
  return {
    type: "choice",
    prompt: action.prompt,
    options,
    to: user.id,
    ...(moved ? { warning: `Recommended option "${moved.label}" moved to first position.` } : {}),
    // On unless the Agent turned it off; only cards made with this field (or after it existed) get it.
    ...(action.other?.enabled === false
      ? {}
      : { other: action.other?.label ? { label: action.other.label } : {} }),
  };
}

export function choiceActionCardView(
  base: ActionCardViewBase,
  card: { result: unknown },
  payload: ResolvedChoicePayload,
  viewerUserId: string,
  pending: boolean,
  userPerson: (userId: string) => ActionCardPersonRef | undefined,
): ActionCardView {
  const person = payload.to ? userPerson(payload.to) : undefined;
  const asked = person ? { ...person, isViewer: person.id === viewerUserId } : undefined;
  return {
    ...base,
    kind: "choice",
    prompt: payload.prompt,
    options: payload.options,
    ...(asked ? { asked } : {}),
    ...(payload.other ? { other: payload.other } : {}),
    canCommit: pending && payload.to === viewerUserId,
    result: card.result as { optionId: string; label: string; text?: string } | undefined,
  };
}

/** Records which option the person clicked, or their own answer ("other"). Free-text chat replies
 * do not commit the card. */
export async function commitChoiceCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  input: { messageId: string; optionId: string; text?: string },
  dependencies: { publisher?: Pick<CentrifugoServerApi, "publishBatch"> } = {},
): Promise<{ optionId: string; label: string; text?: string }> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    input.messageId,
    "choice",
  );
  const payload = card.payload as ResolvedChoicePayload;
  if (payload.to !== principal.actorUserId) throw new AppError("ACCESS_DENIED");
  const answer = choiceAnswer(payload, input);
  const updated = await db.actionCard.updateMany({
    where: { messageId: input.messageId, state: "pending" },
    data: {
      state: "executed",
      committedByUserId: principal.actorUserId,
      committedAt: new Date(),
      result: answer as unknown as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new AppError("CONFLICT");
  await publishActionCardUpdate(db, realtime, card.conversationId, input.messageId);
  await wakeAskingAgent(db, dependencies.publisher, {
    workspaceId: principal.workspaceId,
    messageId: input.messageId,
    conversationId: card.conversationId,
    agentId: card.preparedByAgentId,
    actorUserId: principal.actorUserId,
    prompt: payload.prompt,
    answer,
  });
  return answer;
}

/** The answer a click or the person's own row records; `_other` needs non-blank text within the
 * cap, and only a card that offers it may record one. */
function choiceAnswer(
  payload: ResolvedChoicePayload,
  input: { optionId: string; text?: string },
): { optionId: string; label: string; text?: string; recommended?: true } {
  if (input.optionId === CHOICE_OTHER_OPTION_ID) {
    // A stored payload omits `other` when the Agent turned it off; a hand-made one may still say so.
    const other = payload.other as { label?: string; enabled?: boolean } | undefined;
    if (!other || other.enabled === false) throw new AppError("INVALID_INPUT");
    const text = input.text?.trim();
    if (!text || text.length > CHOICE_OTHER_TEXT_MAX_LENGTH) throw new AppError("INVALID_INPUT");
    return {
      optionId: CHOICE_OTHER_OPTION_ID,
      label: other.label ?? CHOICE_OTHER_DEFAULT_LABEL,
      text,
    };
  }
  const option = payload.options.find((entry) => entry.id === input.optionId);
  if (!option) throw new AppError("INVALID_INPUT");
  return {
    optionId: option.id,
    label: option.label,
    ...(option.recommended ? { recommended: true as const } : {}),
  };
}

/** The choice is a delivery: the Agent that asked is woken with who answered and what they chose,
 * and it does not have to read the card back. No message is posted for the person. */
async function wakeAskingAgent(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "publishBatch"> | undefined,
  input: {
    workspaceId: string;
    messageId: string;
    conversationId: string;
    agentId: string;
    actorUserId: string;
    prompt: string;
    answer: { optionId: string; label: string; text?: string; recommended?: true };
  },
) {
  const [message, agent, actor] = await Promise.all([
    db.message.findUnique({
      where: { id: input.messageId },
      select: {
        id: true,
        sequence: true,
        threadRootId: true,
        conversation: { select: TARGET_CONVERSATION_SELECT },
      },
    }),
    db.agent.findUnique({
      where: { id: input.agentId },
      select: { computerId: true },
    }),
    db.user.findUnique({
      where: { id: input.actorUserId },
      select: { username: true },
    }),
  ]);
  if (!message) return;
  // A user row that is gone leaves the answer anonymous rather than unnamed.
  const who = actor ? `@${actor.username}` : "Someone";
  // The Agent's own card message has no delivery; an existing one means another path wrote it,
  // which must fail loudly rather than have its reason overwritten.
  const delivery = await db.agentMessageDelivery.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      messageId: input.messageId,
      sequence: message.sequence,
      reason: "choice",
    },
    select: { deliveryId: true, createdAt: true },
  });
  const targetOf = await directTargets(db, input.workspaceId, input.agentId, [
    message.conversation,
  ]);
  const target = deliveryTarget(
    conversationTarget(message.conversation, targetOf),
    message.threadRootId,
  );
  const answered =
    input.answer.optionId === CHOICE_OTHER_OPTION_ID
      ? `${input.answer.label} (their own words)\n  │ ${fenceUserText(input.answer.text ?? "")}`
      : `${input.answer.optionId} · ${input.answer.label}${
          input.answer.recommended ? " (recommended)" : ""
        }`;
  await new AgentDeliveryPublisher(publisher ?? createCentrifugoServerApi()).publish(
    input.workspaceId,
    [
      {
        computerId: agent?.computerId ?? null,
        requestId: input.messageId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        messageId: input.messageId,
        deliveryId: delivery.deliveryId,
        sequence: message.sequence,
        createdAtMs: delivery.createdAt.getTime(),
        body: `${who} answered your choice "${input.prompt}" in ${target}: ${answered}`,
        mentions: [],
        target,
        latestSenderKind: "system",
        latestSenderHandle: "",
        latestSenderDescription: "",
      },
    ],
  );
}
