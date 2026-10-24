import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { AGENT_PEER_DIRECT_KEY_WHERE } from "#src/features/conversations/direct-key";
import { agentDmIsLimited } from "#src/server/conversations/agent-dm-limits.server";
import { messagePreviewLine } from "#src/server/conversations/message-preview-line.server";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import {
  agentVisibilityViewerForUser,
  assertAgentVisible,
  canSeeAgent,
} from "./agent-visibility.server";

/** The most conversations one Agent's card lists, newest first. */
const AGENT_PEER_CARD_LIMIT = 20;

export type AgentPeerCard = {
  peer: { agentId: string; name: string; displayName: string; avatar: string };
  /** The last non-system message, cut short; never the full body. */
  preview: string;
  lastMessageAt: Date;
  /** Whether the peer wrote that last message (otherwise the Agent whose card it is did). */
  lastFromPeer: boolean;
  /** Whether the conversation was last held back by a limit within the quiet window. */
  limited: boolean;
};

/**
 * The Agent-to-Agent conversations of `agentId` as the requesting member may see them: nothing at
 * all unless they may see that Agent (`canSeeAgent`, the rule of the Agent's detail panel this card
 * sits in: the stricter `canDirectMessageAgent` would leave the panel's section empty for an admin
 * who can open the panel; the card is a preview only), and no conversation whose peer they may not see (it is left
 * out, not shown as private). People are not members of these conversations, so this is the only
 * way they read them, and only as a preview.
 */
export async function listAgentPeerCards(
  db: Pick<PrismaClient, "agent" | "conversation" | "workspaceMembership" | "$queryRaw">,
  input: { workspaceId: string; agentId: string; userId: string; now?: Date },
): Promise<AgentPeerCard[]> {
  const { workspaceId, agentId } = input;
  const now = input.now ?? new Date();
  const [viewer, subject] = await Promise.all([
    agentVisibilityViewerForUser(db, workspaceId, input.userId),
    db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { visibility: true, ownerId: true, systemKind: true },
    }),
  ]);
  // A missing or deleted Agent answers as an invisible one, so the two cannot be told apart.
  if (!subject) throw new AppError("AGENT_NOT_VISIBLE");
  assertAgentVisible(viewer, subject);

  // Not cut in SQL: the peers' visibility is judged per viewer in memory, so the 20 are taken after.
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      directKey: AGENT_PEER_DIRECT_KEY_WHERE,
      members: { some: { agentId } },
    },
    select: {
      id: true,
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
    return peer && canSeeAgent(viewer, peer) ? [{ conversationId: conversation.id, peer }] : [];
  });
  if (visible.length === 0) return [];

  const conversationIds = visible.map(({ conversationId }) => conversationId);
  // The newest spoken and the newest system message of each conversation, one row each.
  const latest = await db.$queryRaw<
    {
      conversationId: string;
      system: boolean;
      body: string;
      createdAt: Date;
      senderAgentId: string | null;
    }[]
  >`
    SELECT DISTINCT ON (m."conversationId", (m."senderMemberId" IS NULL))
      m."conversationId", (m."senderMemberId" IS NULL) AS "system", CASE WHEN m."senderMemberId" IS NULL THEN m.body ELSE LEFT(m.body, 600) END AS body, m."createdAt",
      cm."agentId" AS "senderAgentId"
    FROM messages m
    LEFT JOIN conversation_members cm ON cm.id = m."senderMemberId"
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
    ORDER BY m."conversationId", (m."senderMemberId" IS NULL), m.sequence DESC`;
  const spokenBy = new Map(latest.filter((m) => !m.system).map((m) => [m.conversationId, m]));
  const heldBy = new Map(latest.filter((m) => m.system).map((m) => [m.conversationId, m]));

  return visible
    .flatMap(({ conversationId, peer }) => {
      const message = spokenBy.get(conversationId);
      if (!message) return [];
      const held = heldBy.get(conversationId);
      return [
        {
          peer: {
            agentId: peer.id,
            name: peer.name,
            displayName: peer.displayName,
            avatar: agentAvatarUrl(peer.id, peer.avatarMascot),
          },
          preview: messagePreviewLine(message.body, []),
          lastMessageAt: message.createdAt,
          lastFromPeer: message.senderAgentId === peer.id,
          limited: agentDmIsLimited(held, now),
        },
      ];
    })
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
    .slice(0, AGENT_PEER_CARD_LIMIT);
}
