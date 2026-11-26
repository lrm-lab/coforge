import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import { resolveMessage, THREAD_ROOT_SCOPE } from "./agent-targets.repositories.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";
import { advanceThreadRead } from "./thread-read-position.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";
import { browserMessageUpdates } from "#src/server/conversations/conversation-history.server";
import {
  browserMessageFields,
  mapBrowserMessages,
} from "#src/server/conversations/browser-message-projection.server";
import { mapBrowserMessagesWithViewerViews } from "#src/server/conversations/viewer-views.server";
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

function unauthorizedScope(): never {
  throw new Error("conversation scope is not authorized");
}

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

async function viewerSide(ports: DirectConversationPorts, conversationId: string, userId: string) {
  const row = await ports.db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      directKey: true,
      members: {
        select: {
          id: true,
          userId: true,
          agentId: true,
          leftAt: true,
          readThroughSequence: true,
          agentReadThroughSequence: true,
          collapseLongMessages: true,
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
              ownerId: true,
              visibility: true,
              appBot: APP_BOT_LOGO_SELECT,
            },
          },
        },
      },
    },
  });
  const sender = row?.members.find((member) => member.userId === userId && member.leftAt === null);
  if (!row || !sender) throw new Error("conversation scope is not authorized");
  const agent = row.members.find((member) => member.agent)?.agent;
  const peer = agent ? undefined : await peerOf(ports, row, userId);
  return { members: row.members, sender, agent, peer };
}

export type ConversationMentionableMember = {
  user: {
    id: string;
    username: string;
    displayName: string;
    description: string | null;
    avatarObjectKey: string | null;
  } | null;
  agent: {
    id: string;
    name: string;
    displayName: string | null;
    description: string | null;
    avatarMascot: string | null;
    visibility?: string;
  } | null;
};

export function conversationMentionables(
  workspaceId: string,
  members: readonly ConversationMentionableMember[],
): Mentionable[] {
  return members
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
              avatarUrl: agentFaceUrl(member.agent),
              mentionScore: 0,
              ...(member.agent.visibility === AGENT_VISIBILITY.PRIVATE
                ? { unmentionable: true as const }
                : {}),
            }
          : undefined,
    )
    .filter((mentionable) => mentionable !== undefined)
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

export async function openConversationForUser(
  ports: DirectConversationPorts,
  workspaceId: string,
  userId: string,
  conversationId: string,
  page: HistoryWindow = {},
) {
  const limit = Math.min(page.limit ?? 50, 100);
  const forward = page.afterSequence !== undefined;
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
  const pageRows = windowRows.slice(0, limit);
  const messages = forward ? pageRows : pageRows.reverse();
  const [{ threads, threadReadThrough }, browserMessages] = await Promise.all([
    readWindowThreads(ports.db, {
      workspaceId,
      conversationId,
      rootIds: messages.map((message) => message.id),
      viewerMemberId: sender.id,
    }),
    page.includeViewerViews
      ? mapBrowserMessagesWithViewerViews(ports.db, messages, workspaceId, userId, {
          authorizedConversationId: conversationId,
        })
      : mapBrowserMessages(ports.db, messages, workspaceId),
  ]);
  const agentMember = agent ? members.find((member) => member.agentId === agent.id) : undefined;
  return {
    conversationId,
    senderMemberId: sender.id,
    collapseLongMessages: sender.collapseLongMessages ?? false,
    othersReadThroughSequence: othersReadThroughSequence(
      sender.id,
      members.filter((member) => member.leftAt === null),
    ),
    threads,
    threadReadThrough,
    ...(agent
      ? {
          kind: "agent" as const,
          agent: {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            deletedAt: agent.deletedAt,
            avatarUrl: agentFaceUrl(agent),
          },
          dmWritable: canDirectMessageAgent(userId, agent),
          ...(agentMember
            ? { agentReadThroughSequence: agentMember.agentReadThroughSequence }
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
    mentionables: conversationMentionables(workspaceId, members),
    hasOlder,
    hasNewer,
    messages: browserMessages,
  };
}

export async function updatesSince(
  ports: DirectConversationPorts,
  workspaceId: string,
  conversationId: string,
  afterSequence: number,
  afterReplySequence?: number,
  options?: { viewerUserId?: string },
) {
  const messages = await browserMessageUpdates(
    ports.db,
    conversationId,
    afterSequence,
    afterReplySequence,
  );
  return options?.viewerUserId
    ? mapBrowserMessagesWithViewerViews(ports.db, messages, workspaceId, options.viewerUserId, {
        authorizedConversationId: conversationId,
      })
    : mapBrowserMessages(ports.db, messages, workspaceId);
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

/** Advances the person's read position in one DM thread; returns whether the cursor actually
 * moved, so the caller announces (and runs the Activity check) only on a real advance. */
export async function markThreadReadForUser(
  ports: DirectConversationPorts,
  workspaceId: string,
  userId: string,
  conversationId: string,
  rootMessageId: string,
  throughSequence: number,
): Promise<boolean> {
  const root = await resolveMessage(ports, conversationId, rootMessageId, THREAD_ROOT_SCOPE);
  const latest = await ports.db.message.findFirst({
    where: {
      conversationId,
      threadRootId: root.id,
      sequence: { lte: throughSequence },
    },
    orderBy: { sequence: "desc" },
  });
  if (!latest) return false;
  const member = await ports.db.conversationMember.findUniqueOrThrow({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
  return advanceThreadRead(
    ports.db,
    member.id,
    conversationId,
    workspaceId,
    root.id,
    latest.sequence,
  );
}
