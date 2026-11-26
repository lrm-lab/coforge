import type { DirectConversationPorts } from "./agent-targets.repositories.server";
import { pendingDeliveryPageSql } from "./agent-attention-page.repositories.server";
import { isRecoverableAgentTarget } from "@lrm/coforge-sdk/internal";
import type { QuestionsAnswer } from "#src/server/conversations/action-card-questions.server";
import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
  AGENT_FORWARD_SELECT,
} from "./direct-conversation-agent-message.server";
import { recoveryRefs, directTargets } from "./agent-peer-direct.repositories.server";
import { readAgentStartOpenTasks } from "./agent-start-open-tasks.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";
import { Prisma } from "#src/generated/prisma/client";
import {
  APP_EVENTS_KIND,
  appEventTarget,
  systemEventTargetFromDirectKey,
} from "#src/server/app-agent-events/app-event-target.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import {
  agentDeliveryView,
  cardDeclinedNotice,
  choiceResultBody,
  desktopTakeoverResultBody,
  feedbackSubmitResultBody,
  pageFillResultBody,
  questionsResultBody,
  type AgentReadableBody,
} from "#src/server/conversations/agent-message-view.server";
import { cardPerson } from "#src/server/conversations/action-card-outcome-body.server";
import { taskReferenceViewForMessages } from "#src/server/conversations/task-reference-view.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  NOTIFIED_AGENT_WHERE,
  unreadAgentMessagesFragment,
} from "#src/server/db/repositories/agent-attention.repositories.server";
import {
  AGENT_RECOVERY_MESSAGE_LIMIT,
  recoverySecondPass,
  type AgentRecoveryRow,
} from "./agent-recovery-row.server";
import type {
  AgentRecoveryContext,
  PendingAgentDelivery,
} from "./direct-conversation-types.server";
type AgentFacing<
  T extends {
    body: string;
  },
> = Omit<T, "body"> & {
  body: AgentReadableBody;
};
const chooserOf = (choosers: ReadonlyMap<string, string>, userId: string) => {
  const handle = choosers.get(userId);
  return handle ? { handle } : null;
};
function answerBody(
  card: {
    kind: string;
    state: string;
    payload: unknown;
    result: unknown;
    committedByUserId: string | null;
  } | null,
  target: string,
  choosers: ReadonlyMap<string, string>,
) {
  const chooser = card?.committedByUserId ? chooserOf(choosers, card.committedByUserId) : null;
  if (card?.state === "cancelled") return cardDeclinedNotice(card, target, chooser);
  if (card?.kind === "page:fill") return pageFillResultBody(card, target, chooser);
  if (card?.kind === "desktop:takeover") return desktopTakeoverResultBody(card, target, chooser);
  if (card?.kind === "feedback:submit") return feedbackSubmitResultBody(card, target, chooser);
  if (card?.kind !== "questions") return choiceResultBody(card, target, chooser);
  const answers =
    (
      card.result as {
        answers?: QuestionsAnswer[];
      } | null
    )?.answers ?? [];
  const prompt = (
    card.payload as {
      prompt?: string;
    } | null
  )?.prompt;
  return questionsResultBody(answers, cardPerson(chooser?.handle), target, prompt);
}
export async function readPendingAgentDeliveries(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  select?: {
    deliveryIds: readonly string[];
    orUnreceived?: boolean;
  },
): Promise<AgentFacing<PendingAgentDelivery>[]> {
  const chosenDeliveryIds = select ? [...select.deliveryIds] : [];
  if (select && !select.orUnreceived && chosenDeliveryIds.length === 0) return [];
  const selected = !select
    ? Prisma.sql`d."receivedAt" IS NULL`
    : !select.orUnreceived
      ? Prisma.sql`d."deliveryId" IN (${Prisma.join(chosenDeliveryIds)})`
      : chosenDeliveryIds.length === 0
        ? Prisma.sql`d."receivedAt" IS NULL`
        : Prisma.sql`(d."receivedAt" IS NULL OR d."deliveryId" IN (${Prisma.join(chosenDeliveryIds)}))`;
  const candidates = (
    await ports.db.$queryRaw<{ deliveryId: string }[]>(
      pendingDeliveryPageSql(workspaceId, agentId, selected, AGENT_RECOVERY_MESSAGE_LIMIT),
    )
  ).map((row) => row.deliveryId);
  const fetched =
    candidates.length === 0
      ? []
      : await ports.db.agentMessageDelivery.findMany({
          where: { deliveryId: { in: candidates } },
          select: {
            deliveryId: true,
            messageId: true,
            conversationId: true,
            conversation: { select: TARGET_CONVERSATION_SELECT },
            sequence: true,
            reason: true,
            message: {
              select: {
                body: true,
                createdAt: true,
                threadRootId: true,
                sender: MESSAGE_SENDER_SELECT,
                mentions: MESSAGE_MENTIONS_SELECT,
                forwards: AGENT_FORWARD_SELECT,
                attachments: {
                  select: { id: true, forwardPosition: true },
                  orderBy: { position: "asc" },
                },
                pendingMentionActions: {
                  where: NOTIFIED_AGENT_WHERE(agentId),
                  select: { id: true },
                },
                actionCard: {
                  select: {
                    kind: true,
                    state: true,
                    payload: true,
                    result: true,
                    committedByUserId: true,
                  },
                },
              },
            },
          },
        });
  const deliveryById = new Map(fetched.map((delivery) => [delivery.deliveryId, delivery] as const));
  const deliveries = candidates.flatMap((deliveryId) => {
    const delivery = deliveryById.get(deliveryId);
    return delivery ? [delivery] : [];
  });
  const chooserIds = [
    ...new Set(
      deliveries.flatMap((delivery) =>
        delivery.reason === "choice" && delivery.message.actionCard?.committedByUserId
          ? [delivery.message.actionCard.committedByUserId]
          : [],
      ),
    ),
  ];
  const [memberRows, targetOf, chooserRows, taskViewOf] = await Promise.all([
    ports.db.conversationMember.findMany({
      where: {
        agentId,
        ...ACTIVE_MEMBER_WHERE,
        conversationId: { in: [...new Set(deliveries.map((d) => d.conversationId))] },
      },
      select: { conversationId: true },
    }),
    directTargets(
      ports.db,
      workspaceId,
      agentId,
      deliveries.map((delivery) => delivery.conversation),
    ),
    chooserIds.length
      ? ports.db.user.findMany({
          where: { id: { in: chooserIds } },
          select: { id: true, username: true },
        })
      : Promise.resolve(
          [] as {
            id: string;
            username: string;
          }[],
        ),
    taskReferenceViewForMessages(
      ports.db,
      workspaceId,
      agentId,
      deliveries.map((delivery) => ({
        conversationId: delivery.conversationId,
        body: delivery.message.body,
      })),
    ),
  ]);
  const memberOf = new Set(memberRows.map((member) => member.conversationId));
  const choosers = new Map(chooserRows.map((user) => [user.id, user.username]));
  const still = new Set(
    candidates.length === 0
      ? []
      : (
          await ports.db.$queryRaw<{ deliveryId: string }[]>(
            pendingDeliveryPageSql(
              workspaceId,
              agentId,
              Prisma.sql`(${selected}) AND d."deliveryId" IN (${Prisma.join(candidates)})`,
              AGENT_RECOVERY_MESSAGE_LIMIT,
            ),
          )
        ).map((row) => row.deliveryId),
  );
  return deliveries
    .filter((delivery) => still.has(delivery.deliveryId))
    .map((delivery) => {
      const { actionCard, ...message } = delivery.message;
      const sender = agentMessageSender(delivery.message.sender);
      const target = deliveryTarget(
        conversationTarget(delivery.conversation, targetOf),
        delivery.message.threadRootId,
      );
      return {
        messageId: delivery.messageId,
        deliveryId: delivery.deliveryId,
        conversationId: delivery.conversationId,
        sequence: delivery.sequence,
        createdAtMs: delivery.message.createdAt.getTime(),
        target,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        ...agentDeliveryView(message, agentId, taskViewOf?.(delivery.conversationId)),
        ...(delivery.reason === "choice" ? { body: answerBody(actionCard, target, choosers) } : {}),
        ...(delivery.reason ? { reason: delivery.reason } : {}),
        ...(delivery.conversation.kind === APP_EVENTS_KIND ? { source: "app" as const } : {}),
        ...(delivery.message.pendingMentionActions.length && !memberOf.has(delivery.conversationId)
          ? { nonMemberMention: true }
          : {}),
      };
    });
}
function appEventRowTarget(
  row: Pick<AgentRecoveryRow, "conversationKind" | "directKey" | "appKey">,
): string | undefined {
  if (row.conversationKind !== APP_EVENTS_KIND) return undefined;
  if (row.appKey) return appEventTarget(row.appKey);
  return systemEventTargetFromDirectKey(row.directKey);
}
type RankedRecoveryRow = AgentRecoveryRow & { lastUnreadSequence: number };

export async function readAgentRecoveryContext(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
): Promise<
  Omit<AgentRecoveryContext, "resumeMessages"> & {
    resumeMessages: AgentFacing<AgentRecoveryContext["resumeMessages"][number]>[];
  }
> {
  const [ranked, openTasks] = await Promise.all([
    ports.db.$queryRaw<RankedRecoveryRow[]>`
    WITH unread AS (
      ${unreadAgentMessagesFragment(workspaceId, agentId)}
    ), ranked AS (
      SELECT u.*,
        (COUNT(*) OVER target_partition)::int AS "unreadCount",
        MAX("sequence") OVER target_partition AS "lastUnreadSequence",
        (ROW_NUMBER() OVER (target_partition ORDER BY "sequence"))::int AS "targetRank",
        (ROW_NUMBER() OVER (ORDER BY "conversationId", "rootSequence", "sequence"))::int AS "globalRank"
      FROM unread u
      WINDOW target_partition AS (PARTITION BY "conversationId", "threadRootId")
    )
    SELECT "id", "sequence", "body", "conversationId", "threadRootId", "senderMemberId", "createdAt",
      "deliveryId", "senderAgentName", "senderAgentDescription", "senderUsername",
      "senderUserDescription", "channelName", "otherUsername", "agentPeer", "unreadCount", "globalRank",
      "nonMemberMention", "attachmentId", "conversationKind", "directKey", "appKey", "lastUnreadSequence"
    FROM ranked
    WHERE "globalRank" <= ${AGENT_RECOVERY_MESSAGE_LIMIT} OR "targetRank" = 1
    ORDER BY "globalRank"`,
    readAgentStartOpenTasks(ports.db, workspaceId, agentId).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: "agent_recovery:open_tasks_read_failed",
          workspace_id: workspaceId,
          agent_id: agentId,
          error_type: errorType(error),
        }),
      );
      return undefined;
    }),
  ]);
  const rows = ranked;
  const resumeMessages: AgentFacing<AgentRecoveryContext["resumeMessages"][number]>[] = [];
  const unreadSummary: Record<string, number> = {};
  const unreadConversationIds: Record<string, string> = {};
  const unreadPartitions = new Map<string, RankedRecoveryRow | null>();
  const resumeRows = rows.filter((row) => row.globalRank <= AGENT_RECOVERY_MESSAGE_LIMIT);
  const [{ mentionsByMessage, forwardsByMessage }, directRefOf, taskViewOf] = await Promise.all([
    recoverySecondPass(ports.db, rows),
    recoveryRefs(ports.db, workspaceId, agentId, rows),
    taskReferenceViewForMessages(ports.db, workspaceId, agentId, resumeRows),
  ]);
  for (const row of rows) {
    const appTarget = appEventRowTarget(row);
    if (!row.channelName && !row.otherUsername && !row.attachmentId && !appTarget)
      throw new Error("Agent conversation has no other member to target");
    const target = deliveryTarget(
      appTarget
        ? appTarget
        : row.attachmentId
          ? `attachment:${row.attachmentId}`
          : row.channelName
            ? `#${row.channelName}`
            : directRefOf(row),
      row.threadRootId,
    );
    if (!isRecoverableAgentTarget(target)) continue;
    unreadSummary[target] ??= row.unreadCount;
    unreadConversationIds[target] = row.conversationId;
    const partition = unreadPartitions.get(target);
    if (partition === undefined) unreadPartitions.set(target, row);
    else if (
      partition &&
      (partition.conversationId !== row.conversationId ||
        partition.threadRootId !== row.threadRootId)
    )
      unreadPartitions.set(target, null);
    if (row.globalRank > AGENT_RECOVERY_MESSAGE_LIMIT) continue;
    if (!row.deliveryId) throw new Error(`Unread Agent message has no delivery: ${row.id}`);
    const sender = agentMessageSender(
      row.senderMemberId === null
        ? null
        : {
            agentId: row.senderAgentName !== null ? row.senderMemberId : null,
            agent:
              row.senderAgentName !== null
                ? { name: row.senderAgentName, description: row.senderAgentDescription ?? "" }
                : null,
            user:
              row.senderUsername !== null
                ? { username: row.senderUsername, description: row.senderUserDescription ?? "" }
                : null,
          },
    );
    resumeMessages.push({
      messageId: row.id,
      deliveryId: row.deliveryId,
      conversationId: row.conversationId,
      sequence: row.sequence,
      createdAtMs: row.createdAt.getTime(),
      target,
      latestSenderKind: sender.kind,
      latestSenderHandle: sender.handle,
      latestSenderDescription: sender.description,
      ...agentDeliveryView(
        {
          body: row.body,
          mentions: mentionsByMessage.get(row.id) ?? [],
          forwards: forwardsByMessage.get(row.id)?.forwards,
          attachments: forwardsByMessage.get(row.id)?.attachments,
        },
        agentId,
        taskViewOf?.(row.conversationId),
      ),
      ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
    });
  }
  const sequenceProofs = [...unreadPartitions].flatMap(([target, partition]) =>
    partition &&
    Number.isSafeInteger(partition.lastUnreadSequence) &&
    partition.lastUnreadSequence >= Math.max(partition.unreadCount, partition.sequence)
      ? [[target, partition.lastUnreadSequence] as const]
      : [],
  );
  return {
    resumeMessages,
    unreadSummary,
    ...(sequenceProofs.length ? { lastUnreadSequences: Object.fromEntries(sequenceProofs) } : {}),
    ...(Object.keys(unreadConversationIds).length ? { unreadConversationIds } : {}),
    ...(openTasks ? { openTasks } : {}),
  };
}
