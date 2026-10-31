import { PrismaPg } from "@prisma/adapter-pg";
import {
  AGENT_MESSAGE_ACK_METHOD,
  encodeAgentMentionDeliveryTerminalError,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMessageDeliveryAck,
  type AgentMessageDelivery,
  type MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import { AgentSessions } from "#src/server/agents/agent-sessions.server";
import {
  createAgentDeliveryAckMethod,
  createMentionDeliveryTerminalErrorMethod,
  createMentionDeliveryTransitionMethod,
  type CentrifugoRpcMethod,
} from "#src/server/centrifugo/rpc-handler.server";
import { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentSessionRepository } from "#src/server/db/repositories/agent-session.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { recordingDeliveries } from "./fake-centrifugo";

export const passThrough: MessageRequestIdempotency = {
  execute: (_scope, persist) => persist(),
};
const runtimeConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/**
 * A Workspace with `bob`, `carol` (both launched on the one Computer) and `dave` (not running),
 * all members of a `team-<suffix>` channel, with the tracked-mention services composed over a
 * recording Centrifugo. `connectionString` is the test PostgreSQL, cleaned up by `cleanup()`.
 */
export async function mentionDeliverySetup(connectionString: string) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `md-owner-${suffix}`, username: `md-owner-${suffix}` },
  });
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug: `md-${suffix}`,
    name: "Mention delivery",
    userId: owner.id,
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID() },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: owner.id,
        computerId: computer.id,
        runtimeConfig,
      },
    });
  /** Gives an Agent a running launch bound to a native session, as a session report does. */
  const launch = async (agentId: string, launchId: string, nativeSessionId: string) => {
    const session = await db.agentSession.create({
      data: {
        agentId,
        workspaceId: workspace.id,
        computerId: computer.id,
        provider: "pi",
        nativeSessionId,
        state: "resumable",
      },
    });
    await db.agent.update({
      where: { id: agentId },
      data: {
        currentSessionId: session.id,
        runtimeSession: {
          provider: "pi",
          computerId: computer.id,
          startRequestId: crypto.randomUUID(),
          daemonInstanceId: "daemon-1",
          launchId,
        },
      },
    });
  };
  const [bob, carol, dave] = await Promise.all([agent("bob"), agent("carol"), agent("dave")]);
  await launch(bob.id, "launch-bob-1", "native-bob-1");
  await launch(carol.id, "launch-carol-1", "native-carol-1");

  const { publisher, delivered: published } = recordingDeliveries();
  const channels = new PublicChannels(db, passThrough, publisher, undefined, {
    async messageAvailable() {},
    async memberChanged() {},
  });
  const team = await channels.create(workspace.id, owner.id, `team-${suffix}`);
  await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
    userIds: [],
    agentIds: [bob.id, carol.id, dave.id],
  });
  const conversations = new PrismaDirectConversationRepository(db);
  const repository = new PrismaMentionDeliveryRepository(db);
  const mentions = new MentionDeliveryReports(repository, publisher, conversations);
  const principal = { userId: owner.id, workspaceId: workspace.id, computerId: computer.id };
  const rpc = {
    ack: createAgentDeliveryAckMethod(mentions),
    transition: createMentionDeliveryTransitionMethod(mentions),
    terminal: createMentionDeliveryTerminalErrorMethod(mentions),
  };
  const call = async (method: CentrifugoRpcMethod, payload: Uint8Array) => {
    const result = await method(payload, { principal });
    if (!(result instanceof Uint8Array)) throw new Error("rpc method returned no payload");
  };
  const send = async (body: string) => {
    published.length = 0;
    const message = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: team.id,
      idempotencyKey: crypto.randomUUID(),
      body,
    });
    return { id: message.id, deliveries: [...published] };
  };
  const row = (messageId: string, agentId: string) =>
    db.agentMessageDelivery.findUniqueOrThrow({
      where: { messageId_agentId: { messageId, agentId } },
      select: {
        deliveryId: true,
        receivedAt: true,
        mentionOutcome: true,
        mentionStage: true,
        mentionReasonCategory: true,
        mentionTerminalCode: true,
        mentionLaunchId: true,
        mentionSessionId: true,
        mentionSettledAt: true,
      },
    });
  const ack = (delivery: AgentMessageDelivery, mentionDelivery?: MentionDeliveryEnvelope) =>
    call(
      rpc.ack,
      encodeAgentMessageDeliveryAck({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        deliveryId: delivery.deliveryId,
        messageId: delivery.messageId,
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        sequence: delivery.sequence,
        method: AGENT_MESSAGE_ACK_METHOD,
        ...(mentionDelivery ? { mentionDelivery } : {}),
      }),
    );
  const terminal = (
    delivery: AgentMessageDelivery,
    code: string,
    envelope?: MentionDeliveryEnvelope,
  ) =>
    call(
      rpc.terminal,
      encodeAgentMentionDeliveryTerminalError({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        deliveryId: delivery.deliveryId,
        code,
        mentionDelivery: envelope ?? delivery.mentionDelivery!,
      }),
    );
  const transition = (
    delivery: AgentMessageDelivery,
    stage: "daemon_received" | "daemon_pending",
    outcome: "accepted" | "coalesced",
  ) =>
    call(
      rpc.transition,
      encodeAgentMentionDeliveryTransition({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: delivery.workspaceId,
        agentId: delivery.agentId,
        deliveryId: delivery.deliveryId,
        stage,
        outcome,
        mentionDelivery: delivery.mentionDelivery!,
      }),
    );
  const pushTo = (deliveries: AgentMessageDelivery[], agentId: string) =>
    deliveries.find((delivery) => delivery.agentId === agentId)!;
  const control = new AgentControl(
    new PrismaAgentControlStore(db),
    { async publish() {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 60_000 },
    undefined,
    undefined,
    undefined,
    mentions,
  );
  /** The cloud's side of a real session report: a start's fence, then the accepted report. */
  const sessions = new AgentSessions(
    new PrismaAgentSessionRepository(db),
    async () => "daemon-1",
    mentions,
  );
  const scope = (agentId: string) => ({
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId,
  });
  /** A launch's session was accepted as the Agent's current one. */
  const sessionAccepted = (agentId: string) => mentions.resendForCurrentSession(scope(agentId));
  /** The daemon came back ready with these Agents running. */
  const ready = (running: string[], reports = mentions) =>
    new WorkspaceAgentRecovery(
      new PrismaAgentRepository(db),
      conversations,
      publisher,
      { run: async (_id, work) => work() },
      reports,
    ).recoverWorkspace(workspace.id, computer.id, running);
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  };
  return {
    db,
    repository,
    workspace,
    computer,
    owner,
    bob,
    carol,
    dave,
    suffix,
    team,
    published,
    launch,
    send,
    row,
    ack,
    terminal,
    transition,
    pushTo,
    control,
    principal,
    publisher,
    conversations,
    mentions,
    sessions,
    scope,
    sessionAccepted,
    ready,
    cleanup,
  };
}
