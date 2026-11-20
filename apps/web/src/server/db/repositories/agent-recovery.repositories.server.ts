import type { DirectConversationPorts } from "./agent-targets.repositories.server";
import { artifactNoticeBlockedMessages } from "#src/server/artifacts/artifact-notice-visibility.server";
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
  pageFillResultBody,
  questionsResultBody,
  type AgentReadableBody,
} from "#src/server/conversations/agent-message-view.server";
import { cardPerson } from "#src/server/conversations/action-card-outcome-body.server";
import { taskReferenceView } from "#src/server/conversations/task-reference-view.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  NOTIFIED_AGENT_WHERE,
  pendingDeliveryWhere,
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
  const unreceived = { receivedAt: null } satisfies Prisma.AgentMessageDeliveryWhereInput;
  const chosen = { deliveryId: { in: [...(select?.deliveryIds ?? [])] } };
  const selected = !select
    ? unreceived
    : { AND: [select.orUnreceived ? { OR: [unreceived, chosen] } : chosen] };
  const fetched = await ports.db.agentMessageDelivery.findMany({
    where: await pendingDeliveryWhere(ports.db, { workspaceId, agentId }, selected),
    orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
    take: AGENT_RECOVERY_MESSAGE_LIMIT,
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
          pendingMentionActions: { where: NOTIFIED_AGENT_WHERE(agentId), select: { id: true } },
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
  const blocked = await artifactNoticeBlockedMessages(
    ports.db,
    workspaceId,
    agentId,
    fetched.map((delivery) => delivery.messageId),
  );
  const deliveries = blocked.size
    ? fetched.filter((delivery) => !blocked.has(delivery.messageId))
    : fetched;
  const chooserIds = [
    ...new Set(
      deliveries.flatMap((delivery) =>
        delivery.reason === "choice" && delivery.message.actionCard?.committedByUserId
          ? [delivery.message.actionCard.committedByUserId]
          : [],
      ),
    ),
  ];
  const [memberRows, targetOf, chooserRows] = await Promise.all([
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
  ]);
  const memberOf = new Set(memberRows.map((member) => member.conversationId));
  const choosers = new Map(chooserRows.map((user) => [user.id, user.username]));
  const taskViews = new Map(
    await Promise.all(
      deliveries.map(
        async (delivery) =>
          [
            delivery.deliveryId,
            await taskReferenceView(
              ports.db,
              workspaceId,
              agentId,
              delivery.conversationId,
              delivery.message.body,
            ),
          ] as const,
      ),
    ),
  );
  return deliveries.map((delivery) => {
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
      ...agentDeliveryView(message, agentId, taskViews.get(delivery.deliveryId)),
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
    ports.db.$queryRaw<AgentRecoveryRow[]>`
    WITH unread AS (
      ${unreadAgentMessagesFragment(workspaceId, agentId)}
    ), ranked AS (
      SELECT u.*,
        (COUNT(*) OVER (PARTITION BY "conversationId", "threadRootId"))::int AS "unreadCount",
        (ROW_NUMBER() OVER (PARTITION BY "conversationId", "threadRootId" ORDER BY "sequence"))::int AS "targetRank",
        (ROW_NUMBER() OVER (ORDER BY "conversationId", "rootSequence", "sequence"))::int AS "globalRank"
      FROM unread u
    )
    SELECT "id", "sequence", "body", "conversationId", "threadRootId", "senderMemberId", "createdAt",
      "deliveryId", "senderAgentName", "senderAgentDescription", "senderUsername",
      "senderUserDescription", "channelName", "otherUsername", "agentPeer", "unreadCount", "globalRank",
      "nonMemberMention", "attachmentId", "conversationKind", "directKey", "appKey"
    FROM ranked
    WHERE "globalRank" <= ${AGENT_RECOVERY_MESSAGE_LIMIT} OR "targetRank" = 1
    ORDER BY "globalRank"`,
    readAgentStartOpenTasks(ports.db, workspaceId, agentId),
  ]);
  const blockedNotices = await artifactNoticeBlockedMessages(
    ports.db,
    workspaceId,
    agentId,
    ranked.map((row) => row.id),
  );
  const rows = blockedNotices.size ? ranked.filter((row) => !blockedNotices.has(row.id)) : ranked;
  const resumeMessages: AgentFacing<AgentRecoveryContext["resumeMessages"][number]>[] = [];
  const unreadSummary: Record<string, number> = {};
  const unreadConversationIds: Record<string, string> = {};
  const { mentionsByMessage, forwardsByMessage } = await recoverySecondPass(ports.db, rows);
  const directRefOf = await recoveryRefs(ports.db, workspaceId, agentId, rows);
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
        await taskReferenceView(ports.db, workspaceId, agentId, row.conversationId, row.body),
      ),
      ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
    });
  }
  return {
    resumeMessages,
    unreadSummary,
    ...(Object.keys(unreadConversationIds).length ? { unreadConversationIds } : {}),
    ...(openTasks ? { openTasks } : {}),
  };
}
