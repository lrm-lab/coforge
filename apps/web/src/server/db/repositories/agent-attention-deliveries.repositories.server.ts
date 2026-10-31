import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  TARGETABLE_CONVERSATION_WHERE,
  directConversationSql,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";

/**
 * The Agent-side half of the attention rule: which delivery rows still owe the Agent attention.
 * The Prisma `where` filters the recovery, drain and pending-context readers apply, and the raw
 * SQL fragment the unread-message reads share, so those reads cannot drift apart. The raw SQL
 * names the tables and columns Prisma maps the models to (`@@map`), which a migration must keep
 * in step.
 */

/**
 * An Agent's attention rule: which messages it still owes attention to, as the Prisma filters and
 * the SQL that the direct-conversation repository's recovery, drain, pending-context and delivery
 * reads share, so those reads cannot drift apart. The raw SQL names the tables and columns Prisma
 * maps the models to (`@@map`), which a migration must keep in step. The human counterpart is
 * `server/conversations/human-unread.server.ts`.
 */

/** A mention whose target is this Agent, which the sender had it notified of. */
export const NOTIFIED_AGENT_WHERE = (agentId: string) =>
  ({
    targetAgentId: agentId,
    notifiedAt: { not: null },
  }) satisfies Prisma.PendingMentionActionWhereInput;

/**
 * A delivery past its `expiresAt` is stale: the Agent owes it no attention and it is never pushed
 * or replayed, though its Message stays in history (an app's event past its expiry). The one rule,
 * on the database clock (`expiresAt` is stored as UTC without a zone) and on the delivery row, so a
 * Message nobody but a delivery makes the Agent's concern (a system Message) drops out of every
 * attention read without a rule of its own.
 */
export const liveDeliverySql = (alias: string) =>
  Prisma.raw(`(${alias}."expiresAt" IS NULL OR ${alias}."expiresAt" > (now() AT TIME ZONE 'UTC'))`);

/**
 * The `where` of the Agent's unreplayed deliveries, from `selected` (which deliveries), less the
 * stale ones (`liveDeliverySql`'s counterpart: Prisma cannot compare to the database clock).
 */
export async function pendingDeliveryWhere(
  db: Pick<PrismaClient, "$queryRaw">,
  scope: { workspaceId: string; agentId: string },
  selected: Prisma.AgentMessageDeliveryWhereInput,
): Promise<Prisma.AgentMessageDeliveryWhereInput> {
  const { workspaceId, agentId } = scope;
  const stale = await db.$queryRaw<{ deliveryId: string }[]>`
    SELECT "deliveryId" FROM "agent_message_deliveries"
    WHERE "agentId" = ${agentId}::uuid AND "receivedAt" IS NULL
      AND "expiresAt" <= (now() AT TIME ZONE 'UTC')`;
  return {
    workspaceId,
    agentId,
    ...selected,
    deliveryId: { notIn: stale.map((row) => row.deliveryId) },
    conversation: {
      ...VISIBLE_CONVERSATION_WHERE,
      OR: [
        TARGETABLE_CONVERSATION_WHERE,
        { kind: "attachment_comments" },
        // A task's conversation has no channel of its own: it replays only while its board is
        // still one the Agent may read.
        {
          kind: "task_thread",
          taskDiscussionOf: {
            conversation: {
              OR: [
                visibleChannelWhere(workspaceId, { agentId }),
                { ...VISIBLE_CONVERSATION_WHERE, ...DIRECT_CONVERSATION_WHERE },
              ],
            },
          },
        },
      ],
    },
    OR: [
      { conversation: DIRECT_CONVERSATION_WHERE },
      {
        conversation: {
          // `kind` is null for a channel or a DM, which `not` would leave out. A comment
          // conversation's seat is only bookkeeping — a stale one must not replay a delivery
          // after the Agent lost the attachment's source conversation; the comment branch below
          // rechecks that membership itself.
          OR: [{ kind: null }, { kind: { notIn: ["task_thread", "attachment_comments"] } }],
          members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
        },
      },
      // A task's conversation is the Agent's while it follows the task; its seat there only
      // keeps a read position.
      {
        conversation: {
          taskDiscussionOf: {
            follows: { some: { member: { agentId, ...ACTIVE_MEMBER_WHERE } } },
          },
        },
      },
      // A comment notification: the delivery counts while the Agent is still an active member of
      // the attachment's source conversation, the rule comment reads recheck on every access.
      {
        conversation: {
          kind: "attachment_comments",
          attachmentCommentThread: {
            attachment: {
              conversation: {
                ...VISIBLE_CONVERSATION_WHERE,
                members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
              },
            },
          },
        },
      },
      // A message it was notified of from outside the channel, while the channel stays one it may
      // read: never a private one it is not in.
      {
        conversation: visibleChannelWhere(workspaceId, { agentId }),
        message: { pendingMentionActions: { some: NOTIFIED_AGENT_WHERE(agentId) } },
      },
    ],
  };
}

/**
 * Messages the Agent owes attention to: above its per-target read boundary, from a user, or
 * explicitly delivered to it; channels only count with a delivery row. Shared by
 * `readAgentRecoveryContext` and `drainAgentEvents` so the rule cannot drift between them.
 *
 * `senderAgentName`/`senderAgentDescription` and `senderUsername`/`senderUserDescription` carry
 * the message's own author (an Agent, else a human) as separate columns rather than one merged
 * name, so the caller can tell which kind it is and attach its description; a raw SQL
 * statement cannot call the shared `agentMessageSender` projection directly. `otherUsername` is
 * the *recipient* — the conversation's other member (`agentPeer` when that is an Agent), which a DM target needs and a message's
 * sender cannot supply. It is read whether or not that member has left, the way
 * `conversationTarget` names a DM: someone who left the Workspace still names the DM's history.
 *
 * The `m` subquery narrows the scan before the rule is applied, one disjoint branch per
 * conversation kind and level: a channel message only counts with a delivery row, so a channel's
 * top level is an index range over the Agent's deliveries above its boundary, and a direct
 * message's top level is an index range over the history above it. Only thread replies, whose
 * boundary is per thread, are scanned in full. The outer `WHERE` still states the whole rule.
 */
export function unreadAgentMessagesFragment(
  workspaceId: string,
  agentId: string,
  scope?: { conversationId: string; threadRootId: string | null },
) {
  const targetFilter = !scope
    ? Prisma.empty
    : scope.threadRootId
      ? Prisma.sql` AND m."conversationId" = ${scope.conversationId}::uuid AND m."threadRootId" = ${scope.threadRootId}::uuid`
      : Prisma.sql` AND m."conversationId" = ${scope.conversationId}::uuid AND m."threadRootId" IS NULL`;
  // A channel delivery already read while the Agent was notified from outside the channel is not
  // read again as a member.
  const notReadAsNonMember = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "pending_mention_actions" rpma
    WHERE rpma."messageId" = cd."messageId" AND rpma."targetAgentId" = ${agentId}::uuid
      AND rpma."targetReadAt" IS NOT NULL
  )`;
  return Prisma.sql`
    SELECT m."id", m."sequence", m."body", m."conversationId", m."threadRootId",
      m."senderMemberId", m."createdAt", COALESCE(r."sequence", 0) AS "rootSequence",
      -- A comment delivery needs no seat to count (the delivery is the entitlement), and its
      -- recipient may reply on the attachment: it is never a non-member mention.
      d."deliveryId",
      (am."id" IS NULL AND c."kind" IS DISTINCT FROM 'attachment_comments') AS "nonMemberMention",
      sa."name" AS "senderAgentName", sa."description" AS "senderAgentDescription",
      su."username" AS "senderUsername", su."description" AS "senderUserDescription",
      c."channelName",
      (SELECT COALESCE(ou."username", oa."name")
        FROM "conversation_members" om
        LEFT JOIN "users" ou ON ou."id" = om."userId"
        LEFT JOIN "agents" oa ON oa."id" = om."agentId"
        WHERE om."conversationId" = c."id" AND om."id" <> am."id"
        ORDER BY ou."username" NULLS LAST LIMIT 1) AS "otherUsername",
      -- The other member is an Agent: a conversation between two Agents.
      COALESCE(c."directKey" ~ '^agent:[0-9a-f-]+[|]agent:[0-9a-f-]+$', FALSE) AS "agentPeer",
      act."attachmentId"
    FROM (
      SELECT cm."id", cm."sequence", cm."body", cm."conversationId", cm."threadRootId",
        cm."senderMemberId", cm."createdAt"
      FROM "conversation_members" cam
      JOIN "conversations" cc ON cc."id" = cam."conversationId" AND cc."channelName" IS NOT NULL
        AND cc."hiddenFromWorkspaceAt" IS NULL
      -- Each membership reads its own index range above the Agent's boundary; a delivery carries
      -- its message's sequence. OFFSET 0 is an optimization fence: without it PostgreSQL flattens
      -- the subquery and, unable to estimate a bound taken from another row, joins every
      -- delivery the Agent has ever received.
      CROSS JOIN LATERAL (
        SELECT d."messageId" FROM "agent_message_deliveries" d
        WHERE d."agentId" = cam."agentId" AND d."conversationId" = cam."conversationId"
          AND d."sequence" > cam."agentReadThroughSequence"
        OFFSET 0
      ) cd
      JOIN "messages" cm ON cm."id" = cd."messageId" AND cm."threadRootId" IS NULL
      WHERE cam."workspaceId" = ${workspaceId}::uuid AND cam."agentId" = ${agentId}::uuid
        AND cam."leftAt" IS NULL AND ${notReadAsNonMember}
      UNION ALL
      SELECT cm."id", cm."sequence", cm."body", cm."conversationId", cm."threadRootId",
        cm."senderMemberId", cm."createdAt"
      FROM "conversation_members" cam
      JOIN "conversations" cc ON cc."id" = cam."conversationId" AND cc."channelName" IS NOT NULL
        AND cc."hiddenFromWorkspaceAt" IS NULL
      -- Starts from the channel's thread replies and joins each reply's delivery: starting from
      -- the Agent's deliveries would walk its whole channel history again.
      JOIN "messages" cm ON cm."conversationId" = cam."conversationId"
        AND cm."threadRootId" IS NOT NULL
      JOIN "agent_message_deliveries" cd ON cd."messageId" = cm."id" AND cd."agentId" = cam."agentId"
      LEFT JOIN "thread_reads" ctr
        ON ctr."memberId" = cam."id" AND ctr."rootMessageId" = cm."threadRootId"
      WHERE cam."workspaceId" = ${workspaceId}::uuid AND cam."agentId" = ${agentId}::uuid
        AND cam."leftAt" IS NULL AND cm."sequence" > COALESCE(ctr."readThroughSequence", 0)
        AND ${notReadAsNonMember}
      UNION ALL
      SELECT dm."id", dm."sequence", dm."body", dm."conversationId", dm."threadRootId",
        dm."senderMemberId", dm."createdAt"
      FROM "conversation_members" dam
      JOIN "conversations" dc ON dc."id" = dam."conversationId" AND ${directConversationSql("dc")}
      JOIN "messages" dm ON dm."conversationId" = dam."conversationId"
        AND dm."threadRootId" IS NULL AND dm."sequence" > dam."agentReadThroughSequence"
      WHERE dam."workspaceId" = ${workspaceId}::uuid AND dam."agentId" = ${agentId}::uuid
        AND dam."leftAt" IS NULL
      UNION ALL
      SELECT dm."id", dm."sequence", dm."body", dm."conversationId", dm."threadRootId",
        dm."senderMemberId", dm."createdAt"
      FROM "conversation_members" dam
      JOIN "conversations" dc ON dc."id" = dam."conversationId" AND ${directConversationSql("dc")}
      JOIN "messages" dm ON dm."conversationId" = dam."conversationId"
        AND dm."threadRootId" IS NOT NULL
      LEFT JOIN "thread_reads" dtr
        ON dtr."memberId" = dam."id" AND dtr."rootMessageId" = dm."threadRootId"
      WHERE dam."workspaceId" = ${workspaceId}::uuid AND dam."agentId" = ${agentId}::uuid
        AND dam."leftAt" IS NULL AND dm."sequence" > COALESCE(dtr."readThroughSequence", 0)
      UNION ALL
      -- A channel message the Agent was notified of without being a member: unread until it is
      -- read once. A member reads it through its channel branch above instead; a private channel
      -- opens to members only, so here, never a member, only a public channel's notification counts.
      SELECT nm."id", nm."sequence", nm."body", nm."conversationId", nm."threadRootId",
        nm."senderMemberId", nm."createdAt"
      FROM "pending_mention_actions" pma
      JOIN "messages" nm ON nm."id" = pma."messageId"
      JOIN "conversations" nc ON nc."id" = nm."conversationId" AND nc."hiddenFromWorkspaceAt" IS NULL
        AND nc."channelName" IS NOT NULL AND nc."visibility" = ${CHANNEL_VISIBILITY.PUBLIC}
      WHERE pma."workspaceId" = ${workspaceId}::uuid AND pma."targetAgentId" = ${agentId}::uuid
        AND pma."notifiedAt" IS NOT NULL AND pma."targetReadAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "conversation_members" nam
          WHERE nam."conversationId" = nm."conversationId" AND nam."agentId" = ${agentId}::uuid
            AND nam."leftAt" IS NULL
        )
      UNION ALL
      -- A delivered attachment-comment notification: unread while the Agent's comment read
      -- position is behind it and it stays an active member of the attachment's source
      -- conversation, the recheck a comment read applies. Its comment-conversation seat is not
      -- required — the delivery row carries the entitlement.
      SELECT nm."id", nm."sequence", nm."body", nm."conversationId", nm."threadRootId",
        nm."senderMemberId", nm."createdAt"
      FROM "agent_message_deliveries" d
      JOIN "messages" nm ON nm."id" = d."messageId"
      JOIN "conversations" nc ON nc."id" = nm."conversationId"
        AND nc."kind" = 'attachment_comments' AND nc."hiddenFromWorkspaceAt" IS NULL
      JOIN "attachment_comment_threads" act ON act."conversationId" = nc."id"
      JOIN "attachments" att ON att."id" = act."attachmentId"
      JOIN "conversations" src ON src."id" = att."conversationId"
        AND src."hiddenFromWorkspaceAt" IS NULL
      JOIN "conversation_members" sm ON sm."conversationId" = src."id"
        AND sm."agentId" = d."agentId" AND sm."leftAt" IS NULL
      WHERE d."workspaceId" = ${workspaceId}::uuid AND d."agentId" = ${agentId}::uuid
        AND ${liveDeliverySql("d")}
    ) m
    LEFT JOIN "conversation_members" am ON am."conversationId" = m."conversationId"
      AND am."workspaceId" = ${workspaceId}::uuid AND am."agentId" = ${agentId}::uuid
      AND am."leftAt" IS NULL
    JOIN "conversations" c ON c."id" = m."conversationId"
    LEFT JOIN "messages" r ON r."id" = m."threadRootId"
    LEFT JOIN "thread_reads" tr ON tr."memberId" = am."id" AND tr."rootMessageId" = m."threadRootId"
    LEFT JOIN "attachment_comment_threads" act ON act."conversationId" = c."id"
    LEFT JOIN "conversation_members" sm ON sm."id" = m."senderMemberId"
    LEFT JOIN "users" su ON su."id" = sm."userId"
    LEFT JOIN "agents" sa ON sa."id" = sm."agentId"
    LEFT JOIN "agent_message_deliveries" d ON d."messageId" = m."id" AND d."agentId" = ${agentId}::uuid
      AND ${liveDeliverySql("d")}
    WHERE (am."id" IS NULL OR m."sequence" > CASE WHEN m."threadRootId" IS NULL
        THEN am."agentReadThroughSequence" ELSE COALESCE(tr."readThroughSequence", 0) END)
      AND (sm."userId" IS NOT NULL OR d."deliveryId" IS NOT NULL)
      AND (${directConversationSql("c")} OR d."deliveryId" IS NOT NULL)
      ${targetFilter}`;
}
