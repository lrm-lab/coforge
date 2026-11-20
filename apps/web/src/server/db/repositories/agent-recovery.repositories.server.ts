import type { DirectConversationPorts } from "./agent-targets.repositories.server";
import { readableArtifactNoticeSql } from "#src/server/artifacts/artifact-notice-visibility.server";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { directConversationSql } from "#src/server/conversations/active-member.server";
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
function pendingDeliveryPageSql(
  workspaceId: string,
  agentId: string,
  selected: Prisma.Sql,
): Prisma.Sql {
  const seat = (alias: string) => Prisma.sql`EXISTS (
    SELECT 1 FROM "conversation_members" seat
    WHERE seat."conversationId" = ${Prisma.raw(alias)}."id"
      AND seat."agentId" = ${agentId}::uuid AND seat."leftAt" IS NULL)`;
  const ordinaryTarget = (alias: string) => Prisma.sql`(
    ${Prisma.raw(alias)}."kind" IS NULL
    OR ${Prisma.raw(alias)}."kind" NOT IN ('task_thread', 'attachment_comments'))`;
  return Prisma.sql`
    SELECT d."deliveryId"
    FROM "agent_message_deliveries" d
    JOIN "messages" msg ON msg."id" = d."messageId"
    JOIN "conversations" c ON c."id" = d."conversationId" AND c."workspaceId" = d."workspaceId"
    WHERE d."workspaceId" = ${workspaceId}::uuid
      AND d."agentId" = ${agentId}::uuid
      AND ${selected}
      AND (d."receivedAt" IS NOT NULL OR d."expiresAt" IS NULL
        OR d."expiresAt" > (now() AT TIME ZONE 'UTC'))
      AND c."hiddenFromWorkspaceAt" IS NULL
      AND (
        c."channelName" IS NOT NULL
        OR ${directConversationSql("c")}
        OR c."kind" = 'attachment_comments'
        OR (c."kind" = 'task_thread' AND EXISTS (
          SELECT 1 FROM "tasks" task
          JOIN "conversations" board ON board."id" = task."conversationId"
          WHERE task."discussionConversationId" = c."id"
            AND (${readableChannelSql("board", workspaceId, { agentId })}
              OR (board."hiddenFromWorkspaceAt" IS NULL AND ${directConversationSql("board")}))))
      )
      AND (
        ${directConversationSql("c")}
        OR (${ordinaryTarget("c")} AND ${seat("c")})
        OR EXISTS (
          SELECT 1 FROM "tasks" followed
          WHERE followed."discussionConversationId" = c."id"
            AND EXISTS (
              SELECT 1 FROM "task_follows" follow
              JOIN "conversation_members" follower ON follower."id" = follow."memberId"
                AND follower."conversationId" = follow."conversationId"
                AND follower."workspaceId" = follow."workspaceId"
              WHERE follow."taskId" = followed."id"
                AND follow."conversationId" = followed."conversationId"
                AND follower."agentId" = ${agentId}::uuid
                AND follower."leftAt" IS NULL))
        OR (
          EXISTS (
            SELECT 1 FROM "attachment_comments" comment_row
            WHERE comment_row."messageId" = msg."id"
              AND comment_row."conversationId" = msg."conversationId")
          AND (
            (${ordinaryTarget("c")} AND ${seat("c")})
            OR (c."kind" = 'attachment_comments' AND EXISTS (
              SELECT 1 FROM "attachment_comment_threads" thread
              JOIN "attachments" attachment ON attachment."id" = thread."attachmentId"
                AND attachment."workspaceId" = thread."workspaceId"
              JOIN "conversations" source ON source."id" = attachment."conversationId"
                AND source."workspaceId" = attachment."workspaceId"
              WHERE thread."conversationId" = c."id"
                AND thread."workspaceId" = c."workspaceId"
                AND source."hiddenFromWorkspaceAt" IS NULL
                AND ${seat("source")}))))
        OR (${readableChannelSql("c", workspaceId, { agentId })} AND EXISTS (
          SELECT 1 FROM "pending_mention_actions" mention
          WHERE mention."messageId" = msg."id"
            AND mention."conversationId" = msg."conversationId"
            AND mention."targetAgentId" = ${agentId}::uuid
            AND mention."notifiedAt" IS NOT NULL))
      )
      AND ${readableArtifactNoticeSql(workspaceId, agentId, Prisma.sql`msg."id"`)}
    ORDER BY d."createdAt" ASC, d."deliveryId" ASC
    LIMIT ${AGENT_RECOVERY_MESSAGE_LIMIT}`;
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
      pendingDeliveryPageSql(workspaceId, agentId, selected),
    )
  ).map((row) => row.deliveryId);
  const page =
    candidates.length === 0
      ? []
      : await ports.db.$queryRaw<{ deliveryId: string }[]>(
          pendingDeliveryPageSql(
            workspaceId,
            agentId,
            Prisma.sql`(${selected}) AND d."deliveryId" IN (${Prisma.join(candidates)})`,
          ),
        );
  const pageIds = page.map((row) => row.deliveryId);
  const fetched =
    pageIds.length === 0
      ? []
      : await ports.db.agentMessageDelivery.findMany({
          where: { deliveryId: { in: pageIds } },
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
  const deliveries = page.flatMap((row) => {
    const delivery = deliveryById.get(row.deliveryId);
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
  const rows = ranked;
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
