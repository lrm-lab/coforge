import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { listAgentWorkspaceChannels } from "#src/server/agents/agent-workspace-roster.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { getAgentSendChannel } from "#src/server/conversations/channel-access.server";
import {
  drainScope,
  type DirectConversationPorts,
} from "#src/server/db/repositories/agent-targets.repositories.server";
import { AppError } from "#src/lib/app-error";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { listAgentChannels } from "#src/server/agents/agent-channel-memberships.server";
import { resolveAgentUserInfo } from "#src/server/agents/agent-user-info.server";
import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import { ActionCardHandles } from "#src/server/conversations/action-card-handles.server";
import { notifyMentionTargets } from "#src/server/conversations/pending-mention-actions.server";
import { pendingMentionActionsForActor } from "#src/server/conversations/pending-mention-views.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { errorOf } from "./helpers/private-channel-fixture";
import { teardown } from "./helpers/workspace-teardown";

/**
 * Task #302, step 4: an Agent reads and manages a private channel only from inside it. An Agent
 * outside it, a Workspace admin Agent included, finds no such channel — the same answer as for a
 * name nobody uses — and cannot reach it by sending, joining or a mention. A Workspace assistant
 * reads as the person it acts for.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;
const suffix = crypto.randomUUID().slice(0, 8);
let fixture: Awaited<ReturnType<typeof setUp>>;

async function setUp(db: PrismaClient) {
  const owner = await db.user.create({
    data: { displayName: `po${suffix}`, username: `po${suffix}` },
  });
  // A Workspace admin outside the private channel.
  const manager = await db.user.create({
    data: { displayName: `pm${suffix}`, username: `pm${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-priv-${suffix}`,
      name: "Agent private channels",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: manager.id, role: "admin" },
        ],
      },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID() },
  });
  const agent = (name: string, role: "member" | "admin") =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `${name}${suffix}`,
        displayName: name,
        role,
        runtimeConfig: {},
      },
    });
  const inside = await agent("inside", "member");
  const outside = await agent("outside", "member");
  // A Workspace admin grants nothing in a private channel it is not in.
  const admin = await agent("admin", "admin");
  // The owner's Workspace assistant, acting for the owner, who is in the private channel.
  await db.workspaceAssistant.create({ data: { workspaceId: workspace.id } });
  const assistant = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `assistant${suffix}`,
      displayName: "assistant",
      visibility: "private",
      systemKind: WORKSPACE_ASSISTANT_KIND,
      runtimeConfig: {},
    },
  });
  await db.workspaceAssistantSession.create({
    data: { workspaceId: workspace.id, userId: owner.id, agentId: assistant.id },
  });
  const secret = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `secret-${suffix}`,
      visibility: "private",
      members: { create: [{ userId: owner.id, channelRole: "admin" }, { agentId: inside.id }] },
    },
  });
  const open = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `open-${suffix}`,
      members: { create: [{ userId: owner.id }] },
    },
  });
  return { workspace, owner, manager, inside, outside, admin, assistant, secret, open };
}

/** A message by the owner in `channel` that mentions `agent` from outside it, with its pending
 * mention action; with `notifiedAt`, notified and delivered as if before the channel went
 * private. */
async function mentionOutside(
  db: PrismaClient,
  channel: { id: string },
  sequence: number,
  agent: { id: string; name: string },
  notifiedAt: Date | null,
) {
  const { workspace, owner } = fixture;
  const sender = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: owner.id },
  });
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: channel.id,
      senderMemberId: sender.id,
      sequence,
      body: `@${agent.name} look ${sequence}`,
    },
  });
  if (notifiedAt)
    await db.agentMessageDelivery.create({
      data: {
        messageId: message.id,
        agentId: agent.id,
        workspaceId: workspace.id,
        conversationId: channel.id,
        sequence,
      },
    });
  const action = await db.pendingMentionAction.create({
    data: {
      messageId: message.id,
      conversationId: channel.id,
      workspaceId: workspace.id,
      senderMemberId: sender.id,
      targetAgentId: agent.id,
      targetHandle: agent.name,
      notifiedAt,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { message, action };
}

beforeAll(async () => {
  if (db) fixture = await setUp(db);
});
afterAll(async () => {
  if (db && fixture) await teardown(db, fixture.workspace.id, [fixture.owner.id]);
  await db?.$disconnect();
});

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) return error.status;
    throw error;
  }
  return undefined;
};

test.skipIf(!db)("an Agent outside a private channel finds no such channel", async () => {
  const { workspace, outside, admin, owner, secret } = fixture;
  const management = new AgentChannelManagement(db!);
  const target = `#${secret.channelName}`;
  for (const agent of [outside, admin]) {
    const calls: [string, () => Promise<unknown>][] = [
      ["info", () => management.info(workspace.id, agent.id, target)],
      ["members", () => management.members(workspace.id, agent.id, target)],
      ["join", () => management.join(workspace.id, agent.id, target)],
      ["leave", () => management.leave(workspace.id, agent.id, target)],
      ["update", () => management.update(workspace.id, agent.id, target, { description: "x" })],
      ["archive", () => management.setArchived(workspace.id, agent.id, target, true)],
      [
        "add-member",
        () => management.addMember(workspace.id, agent.id, target, { agent: `@${agent.name}` }),
      ],
      [
        "remove-member",
        () =>
          management.removeMember(workspace.id, agent.id, target, {
            user: `@${owner.username}`,
          }),
      ],
    ];
    for (const [name, call] of calls)
      expect([agent.name, name, await statusOf(call())]).toEqual([agent.name, name, 404]);
  }
  // Nothing was written: the channel still has its two members and its description.
  const after = await db!.conversation.findUniqueOrThrow({
    where: { id: secret.id },
    include: { members: { where: { leftAt: null } } },
  });
  expect([after.members.length, after.description, after.archivedAt]).toEqual([2, "", null]);
});

test.skipIf(!db)("an Agent inside a private channel sees it as private", async () => {
  const { workspace, inside, secret } = fixture;
  const info = await new AgentChannelManagement(db!).info(
    workspace.id,
    inside.id,
    `#${secret.channelName}`,
  );
  expect(info).toMatchObject({
    name: `#${secret.channelName}`,
    visibility: "private",
    joined: true,
  });
});

test.skipIf(!db)("server info lists a private channel only to its members", async () => {
  const { workspace, inside, outside, assistant, secret, open } = fixture;
  const names = async (agentId: string) =>
    (
      await listAgentWorkspaceChannels(
        db!,
        workspace.id,
        await agentChannelReader(db!, workspace.id, agentId),
        "member",
      )
    ).map((channel) => [channel.name, channel.visibility, channel.joined]);
  expect(await names(inside.id)).toEqual([
    [`#${open.channelName}`, "public", false],
    [`#${secret.channelName}`, "private", true],
  ]);
  expect(await names(outside.id)).toEqual([[`#${open.channelName}`, "public", false]]);
  // A Workspace assistant lists what the person it acts for may read, joined as that person is.
  expect(await names(assistant.id)).toEqual([
    [`#${open.channelName}`, "public", true],
    [`#${secret.channelName}`, "private", true],
  ]);
});

test.skipIf(!db)("sending joins a public channel on the way, never a private one", async () => {
  const { workspace, inside, outside, secret, open } = fixture;
  expect(
    await errorOf(getAgentSendChannel(db!, workspace.id, outside.id, `#${secret.channelName}`)),
  ).toBe("ACCESS_DENIED");
  await expect(
    getAgentSendChannel(db!, workspace.id, outside.id, `#${open.channelName}`),
  ).resolves.toMatchObject({ id: open.id, needsJoin: true });
  await expect(
    getAgentSendChannel(db!, workspace.id, inside.id, `#${secret.channelName}`),
  ).resolves.toMatchObject({ id: secret.id, needsJoin: false });
});

test.skipIf(!db)(
  "a mention in a private channel does not open it to an Agent outside",
  async () => {
    const { workspace, owner, outside, secret, open } = fixture;
    const hidden = await mentionOutside(db!, secret, 1, outside, new Date());
    const shown = await mentionOutside(db!, open, 1, outside, new Date());
    // The Agent is no member, so resolving the target is refused and the mention branch decides.
    const ports = {
      db: db!,
      resolveAgentTarget: async () => {
        throw new AppError("ACCESS_DENIED");
      },
    } as unknown as DirectConversationPorts;
    expect(
      await errorOf(drainScope(ports, workspace.id, outside.id, `#${secret.channelName}`)),
    ).toBe("ACCESS_DENIED");
    // A reconnecting daemon is re-sent only the public channel's delivery.
    const repository = new PrismaDirectConversationRepository(db!);
    const replayed = await repository.readPendingAgentDeliveries(workspace.id, outside.id);
    expect(replayed.map((delivery) => delivery.messageId)).toEqual([shown.message.id]);
    // `message check` with no target, and the recovery context, read the same unread set.
    const { messages } = await repository.drainAgentEvents(workspace.id, outside.id, 50);
    expect(messages.map((message) => message.id)).toEqual([shown.message.id]);
    const unread = await db!.pendingMentionAction.findUniqueOrThrow({
      where: { id: hidden.action.id },
    });
    expect(unread.targetReadAt).toBeNull();

    // A notification not sent yet is refused in the private channel and sent in the public one.
    const pending = await mentionOutside(db!, secret, 2, outside, null);
    const allowed = await mentionOutside(db!, open, 2, outside, null);
    const offered = new Map(
      (await pendingMentionActionsForActor(db!, workspace.id, { userId: owner.id })).map((view) => [
        view.resolutionId,
        view.availableActions,
      ]),
    );
    expect([offered.get(pending.action.id), offered.get(allowed.action.id)]).toEqual([
      ["add"],
      ["notify", "add"],
    ]);
    const { results, deliveries } = await notifyMentionTargets(
      db!,
      workspace.id,
      { userId: owner.id },
      [pending.action.id, allowed.action.id],
    );
    expect(results.map(({ status, reason }) => [status, reason])).toEqual([
      ["no_permission", "private_channel"],
      ["queued", undefined],
    ]);
    expect(deliveries.map((delivery) => delivery.messageId)).toEqual([allowed.message.id]);
    const refused = await db!.pendingMentionAction.findUniqueOrThrow({
      where: { id: pending.action.id },
    });
    expect(refused.notifiedAt).toBeNull();
  },
);

test.skipIf(!db)("an Agent sees a private channel by name only from inside it", async () => {
  const { workspace, owner, manager, inside, outside, assistant, secret, open } = fixture;
  // `user info`: the target's channels, as far as the caller may read them.
  const channelsOf = async (agentId: string) => {
    const outcome = await resolveAgentUserInfo(
      db!,
      { workspaceId: workspace.id, agentId },
      owner.username!,
    );
    if (!("memberships" in outcome.body)) throw new Error(`user info failed: ${outcome.status}`);
    return outcome.body.memberships.map((membership) => membership.channel);
  };
  expect(await channelsOf(outside.id)).toEqual([`#${open.channelName}`]);
  expect(await channelsOf(inside.id)).toEqual([`#${open.channelName}`, `#${secret.channelName}`]);
  expect(await channelsOf(assistant.id)).toEqual([
    `#${open.channelName}`,
    `#${secret.channelName}`,
  ]);

  // An action card's channel, by name or by id.
  const handles = new ActionCardHandles(db!);
  for (const value of [`#${secret.channelName}`, secret.id])
    await expect(
      handles.resolveChannel(workspace.id, outside.id, value, "action.channel"),
    ).rejects.toMatchObject({ code: "INVALID_HANDLE" });
  await expect(
    handles.resolveChannel(workspace.id, inside.id, `#${secret.channelName}`, "action.channel"),
  ).resolves.toBe(secret.id);

  // The inside Agent's profile Chat tab, to a Workspace admin outside and to the owner inside.
  const chatTab = async (userId: string) =>
    (await listAgentChannels(db!, { workspaceId: workspace.id, agentId: inside.id, userId })).map(
      (channel) => channel.name,
    );
  expect(await chatTab(manager.id)).toEqual([]);
  expect(await chatTab(owner.id)).toEqual([secret.channelName!]);
});
