import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import { resolveMessage } from "./agent-targets.repositories.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { advanceThreadRead } from "./thread-read-position.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";
import {
  browserMessageFields,
  browserMessageUpdates,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import { readWindowThreads } from "#src/server/conversations/thread-summaries.server";
import { windowPageFlags } from "#src/lib/conversation-window";
import { othersReadThroughSequence } from "#src/server/conversations/conversation-read-state.server";
import type { HistoryWindow } from "./direct-conversation-types.server";

const PEER_PROFILE_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarObjectKey: true,
} satisfies Prisma.UserSelect;
type PeerProfile = Prisma.UserGetPayload<{ select: typeof PEER_PROFILE_SELECT }>;

/** A direct conversation with neither an Agent nor another person on the other side. */
function unauthorizedScope(): never {
  throw new Error("conversation scope is not authorized");
}

/**
 * The member on the other side of a DM between people, named by its key: the viewer in their
 * conversation with themself, and still the same person after they left the Workspace.
 */
export async function peerOf(
  ports: DirectConversationPorts,
  conversation: {
    directKey: string | null;
    members: { userId: string | null; user: PeerProfile | null }[];
  },
  viewerId: string,
): Promise<PeerProfile | null> {
  const peerId = peopleDirectPeerId(conversation.directKey, viewerId);
  if (!peerId) return null;
  return (
    conversation.members.find((member) => member.userId === peerId)?.user ??
    ports.db.user.findUnique({ where: { id: peerId }, select: PEER_PROFILE_SELECT })
  );
}

/**
 * Who is in one of the viewer's direct conversations, from the viewer's seat: every member's
 * public profile, the viewer's own row, and the Agent or member on the other side.
 */
async function viewerSide(ports: DirectConversationPorts, conversationId: string, userId: string) {
  const row = await ports.db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      directKey: true,
      members: {
        where: ACTIVE_MEMBER_WHERE,
        select: {
          id: true,
          userId: true,
          agentId: true,
          // The viewer's own conversation-level read cursor: the client positions the
          // initial view at the first unread message and draws the divider there.
          readThroughSequence: true,
          agentReadThroughSequence: true,
          // The full public profile: the pane resolves stored `<@kind:uuid>` tokens (and offers
          // @-completion) from these rows, so a mention of the viewer — the row that used to be
          // missing — is resolvable without a second query.
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              deletedAt: true,
              avatarMascot: true,
              // Not sent to the browser (see the trimmed `agent:` field of the open); read only
              // to compute `dmWritable`.
              ownerId: true,
              visibility: true,
            },
          },
        },
      },
    },
  });
  const sender = row?.members.find((member) => member.userId === userId);
  if (!row || !sender) throw new Error("conversation scope is not authorized");
  const agent = row.members.find((member) => member.agent)?.agent;
  const peer = agent ? undefined : await peerOf(ports, row, userId);
  return { members: row.members, sender, agent, peer };
}

/**
 * A window of one of the viewer's direct conversations, by its id, and who is on the other side:
 * an Agent, or a member (the viewer themself in their own). Whether the viewer may read it is
 * `DirectConversations.authorize`'s to decide.
 */
export async function openConversationForUser(
  ports: DirectConversationPorts,
  workspaceId: string,
  userId: string,
  conversationId: string,
  page: HistoryWindow = {},
) {
  const limit = Math.min(page.limit ?? 50, 100);
  // A forward fetch reads towards the live end, from the newest sequence the retained window
  // still holds; a backward fetch reads history upwards from its oldest. Neither is the initial
  // (uncursored) load, which lands on the newest page (see `lib/conversation-window.ts`).
  const forward = page.afterSequence !== undefined;
  // The window does not wait for the conversation's members: both are read by the conversation
  // id alone, and whether the viewer may read it is the caller's to have decided already.
  const [{ members, sender, agent, peer }, windowRows] = await Promise.all([
    viewerSide(ports, conversationId, userId),
    ports.db.message.findMany({
      where: {
        conversationId,
        threadRootId: null,
        sequence: forward
          ? { gt: page.afterSequence }
          : page.beforeSequence
            ? { lt: page.beforeSequence }
            : undefined,
      },
      // Both directions take `limit + 1` rows to learn whether one more remains; the page
      // itself is re-sorted by sequence below, so only the overflow row's presence matters.
      orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
      take: limit + 1,
      select: browserMessageFields,
    }),
  ]);
  const overflow = windowRows.length > limit;
  const { hasOlder, hasNewer } = windowPageFlags(
    forward ? "forward" : page.beforeSequence ? "backward" : "initial",
    overflow,
  );
  // The overflow row is always the newest of the fetched rows, so dropping the tail of the
  // ordered list keeps the reader's side of the window and drops the row that only proved there
  // was more.
  const pageRows = windowRows.slice(0, limit);
  const messages = forward ? pageRows : pageRows.reverse();
  // Each thread of the page as a summary, read through the viewer's own member row (the Agent
  // records a boundary for every thread it drains, which this open never returns) and for these
  // roots only.
  const { threads, threadReadThrough } = await readWindowThreads(ports.db, {
    workspaceId,
    conversationId,
    rootIds: messages.map((message) => message.id),
    viewerMemberId: sender.id,
  });
  return {
    conversationId,
    senderMemberId: sender.id,
    othersReadThroughSequence: othersReadThroughSequence(sender.id, members),
    // The viewer's conversation-level read boundary: first unread = first top-level
    // message past this. Thread replies are positioned by their thread instead.
    readThroughSequence: sender.readThroughSequence,
    threads,
    threadReadThrough,
    ...(agent
      ? {
          kind: "agent" as const,
          // Never the Agent row wholesale: `ownerId`/`visibility` are read above only to
          // compute `dmWritable` and must not reach the browser payload.
          agent: {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            deletedAt: agent.deletedAt,
            avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
          },
          // Whether this viewer may still send here: a private Agent's DM stays scoped to
          // its own creator, so an existing DM held by anyone else reads read-only once it goes
          // private. Independent of `deletedAt`'s own read-only rule.
          dmWritable: canDirectMessageAgent(userId, agent),
          ...(members.find((member) => member.agentId === agent.id)
            ? {
                agentReadThroughSequence: members.find((member) => member.agentId === agent.id)!
                  .agentReadThroughSequence,
              }
            : {}),
        }
      : peer
        ? {
            kind: "people" as const,
            peer: {
              id: peer.id,
              username: peer.username,
              displayName: browserSenderName({ user: peer }),
              avatarUrl: workspaceUserAvatarUrl(workspaceId, peer.id, peer.avatarObjectKey ?? null),
            },
          }
        : unauthorizedScope()),
    viewerId: sender.user ? userId : undefined,
    // DM mention candidates have zero affinity and sort by handle. Include the viewer so
    // their own stored human mention resolves instead of rendering a raw token.
    mentionables: members
      .map((member) =>
        member.user
          ? {
              kind: "user" as const,
              id: member.user.id,
              handle: member.user.username,
              label: humanLabel(member.user),
              description: member.user.description?.trim() ?? "",
              avatarUrl: workspaceUserAvatarUrl(
                workspaceId,
                member.user.id,
                member.user.avatarObjectKey ?? null,
              ),
              mentionScore: 0,
            }
          : member.agent
            ? {
                kind: "agent" as const,
                id: member.agent.id,
                handle: member.agent.name,
                label: member.agent.displayName?.trim() || member.agent.name,
                description: member.agent.description?.trim() ?? "",
                avatarUrl: agentAvatarUrl(member.agent.id, member.agent.avatarMascot),
                mentionScore: 0,
              }
            : undefined,
      )
      .filter((mentionable) => mentionable !== undefined)
      .sort((left, right) => left.handle.localeCompare(right.handle)),
    hasOlder,
    hasNewer,
    messages: messages.map((message) => mapBrowserMessage(message, workspaceId)),
  };
}

/** What arrived in a direct conversation after `afterSequence`, threads included (see
 * `messagesArrivedWhere` for `afterReplySequence`). */
export async function updatesSince(
  ports: DirectConversationPorts,
  workspaceId: string,
  conversationId: string,
  afterSequence: number,
  afterReplySequence?: number,
) {
  const messages = await browserMessageUpdates(
    ports.db,
    conversationId,
    afterSequence,
    afterReplySequence,
  );
  return messages.map((message) => mapBrowserMessage(message, workspaceId));
}

/** Advances the person's DM read cursor (`markHumanRead`): where it left them, or undefined
 * when nothing moved. */
export async function markReadForUser(
  ports: DirectConversationPorts,
  userId: string,
  conversationId: string,
  throughSequence: number,
) {
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
    throw new AppError("INVALID_INPUT");
  return markHumanRead(ports.db, { conversationId, userId, throughSequence });
}

export async function markThreadReadForUser(
  ports: DirectConversationPorts,
  workspaceId: string,
  userId: string,
  conversationId: string,
  rootMessageId: string,
  throughSequence: number,
) {
  const root = await resolveMessage(ports, conversationId, rootMessageId, true);
  const latest = await ports.db.message.findFirst({
    where: {
      conversationId,
      threadRootId: root.id,
      sequence: { lte: throughSequence },
    },
    orderBy: { sequence: "desc" },
  });
  if (!latest) return;
  const member = await ports.db.conversationMember.findUniqueOrThrow({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
  await advanceThreadRead(
    ports.db,
    member.id,
    conversationId,
    workspaceId,
    root.id,
    latest.sequence,
  );
}
