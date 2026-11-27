import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import {
  conversationRealtimeChannel,
  type ConversationPinnedArtifactChangedEvent,
} from "#src/features/conversations/conversation-realtime";
import { agentDirectKey, peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import {
  productionArtifacts,
  type PinnedArtifactSummary,
} from "#src/server/artifacts/artifact-composition.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { errorType } from "#src/server/errors/error-type.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { deriveChannelAdminBasis, deriveChannelCapabilities } from "./channel-authority.server";
import { canReadChannel } from "./channel-read-access.server";
import { lockConversation } from "./conversation-lock.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { messageSignalScope } from "./conversation-signal-scope.server";

export type ConversationPinnedArtifactView = {
  pinned: PinnedArtifactSummary | null;
  canEdit: boolean;
};

type AuthorizedConversation = {
  id: string;
  workspaceId: string;
  isDm: boolean;
  canEdit: boolean;
  memberId: string | null;
  pinnedArtifactId: string | null;
};

async function authorizeConversationPin(
  db: PrismaClient,
  workspaceId: string,
  conversationId: string,
  userId: string,
): Promise<AuthorizedConversation> {
  const [conversation, workspaceMembership] = await Promise.all([
    db.conversation.findFirst({
      where: {
        id: conversationId,
        workspaceId,
        hiddenFromWorkspaceAt: null,
        kind: null,
      },
      select: {
        id: true,
        workspaceId: true,
        channelName: true,
        directKey: true,
        visibility: true,
        archivedAt: true,
        pinnedArtifact: { select: { artifactId: true } },
        members: {
          where: { OR: [{ agentId: { not: null } }, { userId, ...ACTIVE_MEMBER_WHERE }] },
          select: {
            id: true,
            userId: true,
            channelRole: true,
            agent: { select: { id: true, ownerId: true, visibility: true, deletedAt: true } },
          },
        },
      },
    }),
    db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    }),
  ]);
  if (
    !workspaceMembership ||
    !conversation ||
    (conversation.channelName === null && conversation.directKey === null)
  ) {
    throw new AppError("NOT_FOUND");
  }

  const membership = conversation.members.find((member) => member.userId === userId) ?? null;
  const isDm = conversation.channelName === null;
  const pinnedArtifactId = conversation.pinnedArtifact?.artifactId ?? null;

  if (isDm) {
    if (!membership || !conversation.directKey) throw new AppError("NOT_FOUND");
    const peerUserId = peopleDirectPeerId(conversation.directKey, userId);
    if (peerUserId) {
      return {
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        isDm: true,
        canEdit: conversation.archivedAt === null,
        memberId: membership.id,
        pinnedArtifactId,
      };
    }
    const agent = conversation.members.find((member) => member.agent)?.agent;
    if (!agent) throw new AppError("NOT_FOUND");
    if (
      conversation.directKey !== agentDirectKey(userId, agent.id) ||
      !canDirectMessageAgent(userId, agent)
    ) {
      throw new AppError("ACCESS_DENIED");
    }
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      isDm: true,
      canEdit: conversation.archivedAt === null && agent.deletedAt === null,
      memberId: membership.id,
      pinnedArtifactId,
    };
  }

  if (!canReadChannel(conversation, membership !== null)) {
    throw new AppError("NOT_FOUND");
  }

  const adminBasis = deriveChannelAdminBasis(workspaceMembership.role, membership?.channelRole);
  const capabilities = deriveChannelCapabilities({
    isHuman: true,
    isActiveMember: membership !== null,
    isGeneral: conversation.channelName === "general",
    adminBasis,
  });

  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    isDm: false,
    canEdit: capabilities.update && conversation.archivedAt === null,
    memberId: membership?.id ?? null,
    pinnedArtifactId,
  };
}

function noticeBody(input: {
  actorName: string;
  change: "set" | "replaced" | "removed";
  title: string;
  isDm: boolean;
}): string {
  const label = input.title.trim();
  if (!label) {
    switch (input.change) {
      case "set":
        return input.isDm
          ? `${input.actorName} pinned an artifact in this conversation.`
          : `${input.actorName} pinned an artifact in this channel.`;
      case "replaced":
        return input.isDm
          ? `${input.actorName} replaced the pinned artifact.`
          : `${input.actorName} replaced the channel's pinned artifact.`;
      case "removed":
        return input.isDm
          ? `${input.actorName} unpinned the artifact.`
          : `${input.actorName} unpinned the channel's artifact.`;
    }
  }
  switch (input.change) {
    case "set":
      return `${input.actorName} pinned "${label}".`;
    case "replaced":
      return `${input.actorName} replaced the pinned artifact with "${label}".`;
    case "removed":
      return `${input.actorName} unpinned "${label}".`;
  }
}

export async function readConversationPinnedArtifact(
  db: PrismaClient,
  input: { workspaceId: string; conversationId: string; userId: string },
): Promise<ConversationPinnedArtifactView> {
  const auth = await authorizeConversationPin(
    db,
    input.workspaceId,
    input.conversationId,
    input.userId,
  );
  if (!auth.pinnedArtifactId) return { pinned: null, canEdit: auth.canEdit };
  const pinned = await productionArtifacts(db).pinnedSummary.read({
    workspaceId: input.workspaceId,
    conversationId: auth.id,
    artifactId: auth.pinnedArtifactId,
    userId: input.userId,
  });
  return { pinned, canEdit: auth.canEdit };
}

export async function setConversationPinnedArtifact(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    artifactId: string | null;
  },
): Promise<ConversationPinnedArtifactView> {
  const auth = await authorizeConversationPin(
    db,
    input.workspaceId,
    input.conversationId,
    input.userId,
  );
  if (!auth.canEdit) {
    throw new AppError("ACCESS_DENIED", { errorId: "pinned-artifact-forbidden" });
  }

  const artifacts = productionArtifacts(db);
  const [target, user, preloadedPrevious] = await Promise.all([
    input.artifactId
      ? artifacts.pinnedSummary.verifyHomedInConversation({
          workspaceId: input.workspaceId,
          conversationId: auth.id,
          artifactId: input.artifactId,
        })
      : null,
    db.user.findUnique({
      where: { id: input.userId },
      select: { username: true, displayName: true },
    }),
    auth.pinnedArtifactId
      ? artifacts.pinnedSummary.verifyHomedInConversation({
          workspaceId: input.workspaceId,
          conversationId: auth.id,
          artifactId: auth.pinnedArtifactId,
        })
      : null,
  ]);
  if (input.artifactId && !target) {
    throw new AppError("NOT_FOUND", { errorId: "pinned-artifact-not-in-conversation" });
  }

  const actor = {
    memberId: auth.memberId,
    kind: "user" as const,
    handle: user?.username ?? input.userId,
    displayName: user ? humanLabel(user) : input.userId,
  };

  const published = await db.$transaction(async (tx) => {
    await lockConversation(tx, auth.id);
    const current = await tx.conversationPinnedArtifact.findUnique({
      where: { conversationId: auth.id },
      select: { artifactId: true },
    });

    const previousArtifact = !current
      ? null
      : current.artifactId === auth.pinnedArtifactId
        ? preloadedPrevious
        : await productionArtifacts(
            tx as unknown as PrismaClient,
          ).pinnedSummary.verifyHomedInConversation({
            workspaceId: input.workspaceId,
            conversationId: auth.id,
            artifactId: current.artifactId,
          });

    if (input.artifactId === null) {
      if (!current) return null;
      await tx.conversationPinnedArtifact.delete({ where: { conversationId: auth.id } });
      return recordPinNotice(tx, {
        workspaceId: input.workspaceId,
        conversationId: auth.id,
        actor,
        change: "removed",
        artifactId: current.artifactId,
        title: previousArtifact?.title ?? "",
        isDm: auth.isDm,
      });
    }

    if (current?.artifactId === input.artifactId) {
      return null;
    }

    const change: "set" | "replaced" = current && previousArtifact ? "replaced" : "set";
    await tx.conversationPinnedArtifact.upsert({
      where: { conversationId: auth.id },
      create: {
        conversationId: auth.id,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        pinnedByUserId: input.userId,
      },
      update: {
        artifactId: input.artifactId,
        pinnedByUserId: input.userId,
        pinnedByAgentId: null,
        pinnedAt: new Date(),
      },
    });
    return recordPinNotice(tx, {
      workspaceId: input.workspaceId,
      conversationId: auth.id,
      actor,
      change,
      artifactId: input.artifactId,
      title: target!.title,
      isDm: auth.isDm,
    });
  });

  const [, pinned] = await Promise.all([
    published && realtime
      ? (async () => {
          const scope = await messageSignalScope(db, auth.id, input.workspaceId);
          await Promise.all([
            realtime.messageAvailable({
              conversationId: auth.id,
              messageId: published.messageId,
              sequence: published.sequence,
              ...scope,
            }),
            announcePinnedArtifactChanged({
              workspaceId: input.workspaceId,
              conversationId: auth.id,
              artifactId: input.artifactId,
            }),
          ]);
        })()
      : Promise.resolve(),
    input.artifactId
      ? artifacts.pinnedSummary.read({
          workspaceId: input.workspaceId,
          conversationId: auth.id,
          artifactId: input.artifactId,
          userId: input.userId,
        })
      : Promise.resolve(null),
  ]);

  return { pinned, canEdit: auth.canEdit };
}

async function recordPinNotice(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    conversationId: string;
    actor: { memberId: string | null; kind: "user" | "agent"; handle: string; displayName: string };
    change: "set" | "replaced" | "removed";
    artifactId: string;
    title: string;
    isDm: boolean;
  },
): Promise<{ messageId: string; sequence: number }> {
  const sequence = await allocateSequence(tx, input.conversationId);
  const message = await tx.message.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sequence,
      body: noticeBody({
        actorName: input.actor.displayName,
        change: input.change,
        title: input.title,
        isDm: input.isDm,
      }),
    },
    select: { id: true },
  });
  await tx.systemMessage.create({
    data: {
      messageId: message.id,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      kind: "conversation.pinned_artifact_changed",
      params: {
        actor: input.actor as unknown as Prisma.InputJsonValue,
        change: input.change,
        artifactId: input.artifactId,
        title: input.title,
        isDm: input.isDm,
      } as Prisma.InputJsonObject,
    },
  });
  return { messageId: message.id, sequence };
}

async function announcePinnedArtifactChanged(input: {
  workspaceId: string;
  conversationId: string;
  artifactId: string | null;
}) {
  const event: ConversationPinnedArtifactChangedEvent = {
    type: REALTIME_EVENTS.conversationPinnedArtifactChanged,
    conversationId: input.conversationId,
    artifactId: input.artifactId,
  };
  try {
    await createCentrifugoServerApi().publishJson(
      conversationRealtimeChannel(input.conversationId),
      event,
      crypto.randomUUID(),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:pinned_artifact_changed_failed",
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        error_type: errorType(error),
      }),
    );
  }
}
