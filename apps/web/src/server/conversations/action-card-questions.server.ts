import {
  CHOICE_OTHER_DEFAULT_LABEL,
  CHOICE_OTHER_OPTION_ID,
  CHOICE_OTHER_TEXT_MAX_LENGTH,
  type QuestionsAction,
  type ResolvedQuestionsPayload,
} from "@lrm/coforge-sdk/agent";
import type {
  ActionCardPersonRef,
  ActionCardView,
  ActionCardViewBase,
} from "./action-card-view.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { questionsResultBody } from "./agent-message-view.server";
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

/** The questions card's payload, `to` resolved to the asked person's user id — same rule and
 * owner fallback as `choice` (see `resolveChoicePayload`). Each question's recommended option,
 * when not first already, moves first with a warning that names its question. */
export async function resolveQuestionsPayload(
  db: Pick<PrismaClient, "user" | "conversationMember">,
  conversationId: string,
  action: QuestionsAction,
  legacyOwnerUserId?: string,
): Promise<ResolvedQuestionsPayload> {
  const asked = action.to?.trim() ?? legacyOwnerUserId;
  if (!asked)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_questions_to",
      hint: "a questions card must name who it asks: set `to` to their handle or user id",
    });
  const handle = asked.replace(/^@/, "");
  const user = await db.user.findFirst({
    where: USER_ID.test(handle) ? { id: handle } : { username: handle },
    select: { id: true },
  });
  if (!user)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_questions_to",
      hint: "the person to ask does not exist",
    });
  const member = await db.conversationMember.findFirst({
    where: { conversationId, userId: user.id, leftAt: null },
    select: { id: true },
  });
  if (!member)
    throw new AppError("INVALID_INPUT", {
      errorId: "action_card_questions_to",
      hint: "the person to ask is not in this conversation",
    });
  const warnings: string[] = [];
  const questions = action.questions.map((question) => {
    if (question.options.filter((option) => option.recommended === true).length > 1)
      throw new AppError("INVALID_INPUT", {
        errorId: "action_card_questions_recommended",
        hint: `question "${question.id}" marks more than one option recommended`,
      });
    const options = question.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.recommended === true ? { recommended: true as const } : {}),
    }));
    // A recommendation is shown first: moved with a note rather than refused.
    const at = options.findIndex((option) => option.recommended === true);
    const moved = at > 0 ? options.splice(at, 1)[0]! : undefined;
    if (moved) {
      options.unshift(moved);
      warnings.push(
        `Recommended option "${moved.label}" in "${question.prompt}" moved to first position.`,
      );
    }
    return {
      id: question.id,
      prompt: question.prompt,
      select: question.select,
      options,
      ...(question.other?.enabled === false
        ? {}
        : { other: question.other?.label ? { label: question.other.label } : {} }),
    };
  });
  return {
    type: "questions",
    ...(action.prompt ? { prompt: action.prompt } : {}),
    questions,
    to: user.id,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

export function questionsActionCardView(
  base: ActionCardViewBase,
  card: { result: unknown },
  payload: ResolvedQuestionsPayload,
  viewerUserId: string,
  pending: boolean,
  userPerson: (userId: string) => ActionCardPersonRef | undefined,
): ActionCardView {
  const person = payload.to ? userPerson(payload.to) : undefined;
  const asked = person ? { ...person, isViewer: person.id === viewerUserId } : undefined;
  return {
    ...base,
    kind: "questions",
    ...(payload.prompt ? { prompt: payload.prompt } : {}),
    questions: payload.questions,
    ...(asked ? { asked } : {}),
    canCommit: pending && payload.to === viewerUserId,
    result: card.result as { answers: QuestionsAnswer[] } | undefined,
  };
}

/** One question's recorded answer: the picked options as labeled rows, or the person's own
 * answer as the `_other` row carrying its text. */
export type QuestionsAnswerOption = {
  optionId: string;
  label: string;
  recommended?: true;
  text?: string;
};
export type QuestionsAnswer = {
  questionId: string;
  prompt: string;
  selection: QuestionsAnswerOption[];
  /** Left unanswered: the person may skip a question (Frank, 11-04); `selection` is empty. */
  skipped?: true;
};

/** Records the person's one submit — every question's picked options or own answer — and wakes
 * the asking Agent with the full list. Free-text chat replies do not commit the card. */
export async function commitQuestionsCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  input: {
    messageId: string;
    answers: { questionId: string; selection: string[]; text?: string }[];
  },
  dependencies: { publisher?: Pick<CentrifugoServerApi, "publishBatch"> } = {},
): Promise<QuestionsAnswer[]> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    input.messageId,
    "questions",
  );
  const payload = card.payload as ResolvedQuestionsPayload;
  if (payload.to !== principal.actorUserId) throw new AppError("ACCESS_DENIED");
  const answers = questionsAnswers(payload, input.answers);
  const updated = await db.actionCard.updateMany({
    where: { messageId: input.messageId, state: "pending" },
    data: {
      state: "executed",
      committedByUserId: principal.actorUserId,
      committedAt: new Date(),
      result: { answers } as unknown as Prisma.InputJsonValue,
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
    answers,
  });
  return answers;
}

/** A question may be skipped, recorded as such; one answered question at least makes a submit.
 * An answered `one` takes exactly one option, `many` at least one; `_other` needs the question's
 * own-answer row and non-blank text within the cap. */
function questionsAnswers(
  payload: ResolvedQuestionsPayload,
  input: { questionId: string; selection: string[]; text?: string }[],
): QuestionsAnswer[] {
  const byId = new Map(input.map((entry) => [entry.questionId, entry]));
  if (byId.size !== input.length) throw new AppError("INVALID_INPUT");
  if (
    input.some((entry) => !payload.questions.some((question) => question.id === entry.questionId))
  )
    throw new AppError("INVALID_INPUT");
  const answers = payload.questions.map((question): QuestionsAnswer => {
    const answer = byId.get(question.id);
    if (!answer || answer.selection.length === 0)
      return { questionId: question.id, prompt: question.prompt, selection: [], skipped: true };
    if (question.select === "one" && answer.selection.length !== 1)
      throw new AppError("INVALID_INPUT");
    const selection = answer.selection.map((optionId): QuestionsAnswerOption => {
      if (optionId === CHOICE_OTHER_OPTION_ID) {
        // A stored payload omits `other` when the Agent turned it off.
        const other = question.other as { label?: string; enabled?: boolean } | undefined;
        if (!other || other.enabled === false) throw new AppError("INVALID_INPUT");
        const text = answer.text?.trim();
        if (!text || text.length > CHOICE_OTHER_TEXT_MAX_LENGTH)
          throw new AppError("INVALID_INPUT");
        return {
          optionId: CHOICE_OTHER_OPTION_ID,
          label: other.label ?? CHOICE_OTHER_DEFAULT_LABEL,
          text,
        };
      }
      const option = question.options.find((entry) => entry.id === optionId);
      if (!option) throw new AppError("INVALID_INPUT");
      return {
        optionId: option.id,
        label: option.label,
        ...(option.recommended ? { recommended: true as const } : {}),
      };
    });
    return { questionId: question.id, prompt: question.prompt, selection };
  });
  if (answers.every((answer) => answer.skipped)) throw new AppError("INVALID_INPUT");
  return answers;
}

/** The submit is a delivery: the Agent that asked is woken with who answered and every
 * question's answer — it reads messages, not the card. No message is posted for the person. */
async function wakeAskingAgent(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "publishBatch"> | undefined,
  input: {
    workspaceId: string;
    messageId: string;
    conversationId: string;
    agentId: string;
    actorUserId: string;
    answers: QuestionsAnswer[];
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
        body: questionsResultBody(input.answers, who, target),
        mentions: [],
        target,
        latestSenderKind: "system",
        latestSenderHandle: "",
        latestSenderDescription: "",
      },
    ],
  );
}
