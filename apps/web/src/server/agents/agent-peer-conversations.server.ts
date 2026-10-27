import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { AGENT_PEER_DIRECT_KEY_WHERE } from "#src/features/conversations/direct-key";
import { agentDmIsLimited } from "#src/server/conversations/agent-dm-limits.server";
import {
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
} from "#src/server/conversations/mentions.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { assertAgentChatReadable } from "./agent-chat-access.server";
import { canSeeAgent } from "./agent-visibility.server";

/** The most conversations one Agent's card lists. */
const AGENT_PEER_CARD_LIMIT = 20;
/** The longest message body a card carries, in characters; the card clamps it to three lines. */
const PEER_PREVIEW_BODY_MAX = 600;

type PeerCardMention = ReturnType<typeof browserMessageMention>;

export type AgentPeerCard = {
  peer: { agentId: string; name: string; displayName: string; avatar: string };
  /** The last non-system message, its body cut short with its mentions for Markdown rendering;
   * `null` while the conversation has no message yet. */
  message: { body: string; mentions: PeerCardMention[] } | null;
  /** When that message was written, else when the conversation was created. */
  at: Date;
  /** Whether the conversation was last held back by a limit within the quiet window. */
  limited: boolean;
};

/**
 * The Agent-to-Agent conversations of `agentId` as the requesting member may see them: nothing at
 * all unless they may read that Agent's Chat tab (`assertAgentChatReadable`), and no conversation
 * whose peer they may not see (it is left out, not shown as private). Conversations with a message
 * come first, newest message first, then those with none, newest created first. People are not
 * members of these conversations, so this is the only way they read them, and only the last
 * message of each, cut short.
 */
export async function listAgentPeerCards(
  db: Pick<
    PrismaClient,
    "agent" | "conversation" | "messageMention" | "workspaceMembership" | "$queryRaw"
  >,
  input: { workspaceId: string; agentId: string; userId: string; now?: Date },
): Promise<AgentPeerCard[]> {
  const { workspaceId, agentId } = input;
  const now = input.now ?? new Date();
  const viewer = await assertAgentChatReadable(db, input);

  // Not cut in SQL: the peers' visibility is judged per viewer in memory, so the 20 are taken after.
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      directKey: AGENT_PEER_DIRECT_KEY_WHERE,
      members: { some: { agentId } },
    },
    select: {
      id: true,
      createdAt: true,
      members: {
        where: { agentId: { not: agentId }, agent: ACTIVE_AGENT_WHERE },
        select: {
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              avatarMascot: true,
              visibility: true,
              ownerId: true,
              systemKind: true,
            },
          },
        },
      },
    },
  });
  const visible = conversations.flatMap((conversation) => {
    const peer = conversation.members[0]?.agent;
    return peer && canSeeAgent(viewer, peer)
      ? [{ conversationId: conversation.id, createdAt: conversation.createdAt, peer }]
      : [];
  });
  if (visible.length === 0) return [];

  const conversationIds = visible.map(({ conversationId }) => conversationId);
  // The newest spoken and the newest system message of each conversation: two index seeks on
  // (conversationId, sequence) per conversation, never a sort of its messages. The system lookup
  // filters `senderMemberId IS NULL`, so a conversation with none reads back through all of it; if
  // that ever matters, add a partial index on `senderMemberId IS NULL`.
  const latest = await db.$queryRaw<
    {
      conversationId: string;
      messageId: string | null;
      body: string | null;
      createdAt: Date | null;
      systemBody: string | null;
      systemAt: Date | null;
    }[]
  >`
    SELECT c.id AS "conversationId", sp.id AS "messageId", sp.body, sp."createdAt",
      sy.body AS "systemBody", sy."createdAt" AS "systemAt"
    FROM unnest(ARRAY[${Prisma.join(conversationIds)}]::uuid[]) AS c(id)
    LEFT JOIN LATERAL (
      SELECT m.id, LEFT(m.body, ${Prisma.raw(String(PEER_PREVIEW_BODY_MAX))}) AS body, m."createdAt"
      FROM messages m
      WHERE m."conversationId" = c.id AND m."senderMemberId" IS NOT NULL
      ORDER BY m.sequence DESC LIMIT 1
    ) sp ON true
    LEFT JOIN LATERAL (
      SELECT m.body, m."createdAt" FROM messages m
      WHERE m."conversationId" = c.id AND m."senderMemberId" IS NULL
      ORDER BY m.sequence DESC LIMIT 1
    ) sy ON true`;
  const mentionRows = await db.messageMention.findMany({
    where: { messageId: { in: latest.flatMap((row) => (row.messageId ? [row.messageId] : [])) } },
    select: { messageId: true, ...BROWSER_MESSAGE_MENTIONS_SELECT.select },
  });
  const mentionsByMessage = new Map<string, PeerCardMention[]>();
  for (const row of mentionRows)
    mentionsByMessage.set(row.messageId, [
      ...(mentionsByMessage.get(row.messageId) ?? []),
      browserMessageMention(row),
    ]);
  const latestBy = new Map(latest.map((row) => [row.conversationId, row]));

  const cards = visible.map(({ conversationId, createdAt, peer }) => {
    const row = latestBy.get(conversationId);
    const spoken = row?.messageId && row.body !== null && row.createdAt ? row : undefined;
    return {
      peer: {
        agentId: peer.id,
        name: peer.name,
        displayName: peer.displayName,
        avatar: agentAvatarUrl(peer.id, peer.avatarMascot),
      },
      message: spoken ? cutMessage(spoken.body!, mentionsByMessage.get(spoken.messageId!)) : null,
      at: spoken?.createdAt ?? createdAt,
      limited: agentDmIsLimited(
        row?.systemBody != null && row.systemAt
          ? { body: row.systemBody, createdAt: row.systemAt }
          : undefined,
        now,
      ),
    };
  });
  // Conversations with a message first, each group newest first.
  return cards
    .sort(
      (a, b) =>
        Number(b.message !== null) - Number(a.message !== null) || b.at.getTime() - a.at.getTime(),
    )
    .slice(0, AGENT_PEER_CARD_LIMIT);
}

/** The cut body and only the mentions still in it: a mention past the cut is not sent. The cut can
 * fall inside a `<@kind:id>` token, which would then read as raw text, so a trailing partial token
 * is dropped. */
function cutMessage(body: string, mentions: PeerCardMention[] = []) {
  // Only a body at the limit was cut; a shorter one keeps whatever it ends with.
  const cut = [...body].length < PEER_PREVIEW_BODY_MAX ? body : body.replace(/<@[^>]*$/u, "");
  return { body: cut, mentions: mentions.filter((mention) => cut.includes(mention.actorId)) };
}
