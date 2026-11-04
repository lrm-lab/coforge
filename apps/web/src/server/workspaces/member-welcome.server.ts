import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { humanLabel } from "#src/lib/human-label";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import { announceMessageBestEffort } from "#src/server/conversations/conversation-activity.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  announceViewerEvent,
  CentrifugoConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { errorType } from "#src/server/errors/error-type.server";
import { onboardingAgentWhere } from "./workspace-onboarding.server";

/** A welcome request written in a new member's admission, to publish once that commits. */
export type MemberWelcome = {
  workspaceId: string;
  conversationId: string;
  /** The DM did not exist before this admission. */
  conversationCreated: boolean;
  userId: string;
  /** The newcomer's `@username`, the target the Agent answers to. */
  target: string;
  agentId: string;
  /** The Computer to push to; null while the Agent is stopped, so the delivery waits queued. */
  computerId: string | null;
  message: { id: string; sequence: number; createdAt: Date; body: string; deliveryId: string };
};

/** What the Agent reads; the member sees the localized notice of the same message instead. */
function welcomeRequest(input: { newcomer: string; workspace: string; agent: string }) {
  return [
    `${input.newcomer} just joined ${input.workspace}.`,
    `@${input.agent}, please welcome them in this conversation: briefly introduce the main channels, then ask what they want to do first.`,
    "Write in the language they use, or Chinese when you do not know it.",
  ].join(" ");
}

/**
 * In `agent` mode, writes the request for the Workspace's chosen Agent to welcome `userId`: a
 * system message in their DM with it (made if needed) and the Agent's delivery of it. The
 * delivery row is what keeps the request when the Agent is offline: it is handed over when the
 * Agent is next ready, as any message sent to it is. Runs inside the admission's transaction, so
 * it exists exactly when the membership does. None in any other mode, or when the chosen Agent
 * can no longer welcome.
 */
export async function requestMemberWelcome(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    /** The Workspace's settings as the admission read them. */
    onboarding: { name: string; onboardingMode: string; onboardingAgentId: string | null };
  },
): Promise<MemberWelcome | undefined> {
  const { workspaceId, userId, onboarding: workspace } = input;
  if (workspace.onboardingMode !== "agent" || !workspace.onboardingAgentId) return undefined;
  const agent = await tx.agent.findFirst({
    where: { ...onboardingAgentWhere(workspaceId), id: workspace.onboardingAgentId },
    select: { id: true, name: true, computerId: true, stoppedAt: true },
  });
  if (!agent) return undefined;
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { username: true, displayName: true },
  });

  // The DM, made the way a first open makes it. A rejoining member's earlier one is kept, its
  // history with it (the admission already restored their seat in it).
  const directKey = agentDirectKey(userId, agent.id);
  const made = await tx.conversation.createManyAndReturn({
    data: [{ workspaceId, directKey }],
    skipDuplicates: true,
    select: { id: true },
  });
  const conversation = await tx.conversation.findUniqueOrThrow({
    where: { workspaceId_directKey: { workspaceId, directKey } },
    select: { id: true },
  });
  await tx.conversationMember.createMany({
    data: [
      { workspaceId, conversationId: conversation.id, userId },
      { workspaceId, conversationId: conversation.id, agentId: agent.id },
    ],
    skipDuplicates: true,
  });

  await lockConversation(tx, conversation.id);
  const sequence = await allocateSequence(tx, conversation.id);
  const newcomer = humanLabel(user);
  const body = welcomeRequest({ newcomer, workspace: workspace.name, agent: agent.name });
  const message = await tx.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      sequence,
      body,
      deliveries: {
        create: { workspaceId, conversationId: conversation.id, agentId: agent.id, sequence },
      },
    },
    select: { id: true, sequence: true, createdAt: true, body: true, deliveries: true },
  });
  const [delivery] = message.deliveries;
  await tx.systemMessage.create({
    data: {
      messageId: message.id,
      conversationId: conversation.id,
      workspaceId,
      kind: "member.welcome_requested",
      params: {
        newcomer: { memberId: null, handle: user.username, displayName: newcomer },
        agent: { memberId: null, handle: agent.name, displayName: agent.name },
      },
    },
  });
  return {
    workspaceId,
    conversationId: conversation.id,
    conversationCreated: made.length > 0,
    userId,
    target: `@${user.username}`,
    agentId: agent.id,
    computerId: agent.stoppedAt ? null : agent.computerId,
    message: {
      id: message.id,
      sequence: message.sequence,
      createdAt: message.createdAt,
      body: message.body,
      deliveryId: delivery!.deliveryId,
    },
  };
}

/**
 * After the admission commits: tells the Agent's Computer and the member's pages. Best effort,
 * since the delivery row already holds the request for the Agent's next ready.
 */
export async function publishMemberWelcome(db: PrismaClient, welcome: MemberWelcome) {
  try {
    const publisher = createCentrifugoServerApi();
    const realtime = new CentrifugoConversationRealtime(publisher);
    const { message } = welcome;
    await Promise.allSettled([
      new AgentDeliveryPublisher(publisher).publish(welcome.workspaceId, [
        {
          computerId: welcome.computerId,
          requestId: message.id,
          conversationId: welcome.conversationId,
          agentId: welcome.agentId,
          messageId: message.id,
          deliveryId: message.deliveryId,
          sequence: message.sequence,
          createdAtMs: message.createdAt.getTime(),
          body: message.body,
          mentions: [],
          target: welcome.target,
          latestSenderKind: "system",
          latestSenderHandle: "",
          latestSenderDescription: "",
        },
      ]),
      welcome.conversationCreated
        ? announceViewerEvent(realtime, {
            userIds: [welcome.userId],
            event: {
              type: "dm.created.v1",
              workspaceId: welcome.workspaceId,
              conversationId: welcome.conversationId,
            },
          })
        : undefined,
      announceMessageBestEffort(db, realtime, {
        workspaceId: welcome.workspaceId,
        conversationId: welcome.conversationId,
        messageId: message.id,
        sequence: message.sequence,
      }),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "member_welcome:publish_failed",
        workspace_id: welcome.workspaceId,
        agent_id: welcome.agentId,
        error_type: errorType(error),
      }),
    );
  }
}
