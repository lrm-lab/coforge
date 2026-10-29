import { expect, test } from "bun:test";

import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { joinGeneralChannel } from "#src/server/conversations/general-channel.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { admitWorkspaceMember } from "#src/server/workspaces/member-admission.server";
import { workspaceMemberDirectory } from "#src/server/workspaces/member-directory-store.server";
import {
  defineEmitterCases,
  emitterCase,
  type EmitterFixture,
} from "./helpers/app-notification-emitter-cases";
import { agentIn, channelOf, personIn, unique } from "./helpers/app-notification-emitter-domain";
import { emitterDatabaseUrl, type EmitterEnvironment } from "./helpers/app-notification-emitters";

/**
 * The channel and thread events apps are notified of, against local PostgreSQL: each is recorded by
 * the real domain operation, in its transaction (see `helpers/app-notification-emitter-cases.ts`).
 * Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const channels = (env: EmitterEnvironment, idempotency?: MessageRequestIdempotency) =>
  new PublicChannels(env.db, idempotency, {
    publish: async () => [],
    publishJson: async () => [],
  } as unknown as CentrifugoServerApi);

/** The Agent CLI's channel commands, with no daemon to tell about a purge. */
const agentChannels = (env: EmitterEnvironment) =>
  new AgentChannelManagement(env.db, undefined, undefined, undefined, { purge: async () => {} });

/** A channel with a person and an Agent already in it, and a top-level message to reply to. */
async function threadable(env: EmitterEnvironment, fixture: EmitterFixture) {
  const channel = await channelOf(env, fixture);
  const agent = await agentIn(env, fixture);
  await env.db.conversationMember.create({
    data: { conversationId: channel.id, workspaceId: fixture.workspace.id, agentId: agent.id },
  });
  const owner = await env.db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: fixture.owner.id },
  });
  const root = await env.db.message.create({
    data: {
      workspaceId: fixture.workspace.id,
      conversationId: channel.id,
      senderMemberId: owner.id,
      body: "root",
      sequence: 1,
    },
  });
  return { channel, agent, root };
}

const conversationsOf = (fixture: EmitterFixture) => ({
  table: "conversations",
  column: "workspaceId",
  value: fixture.workspace.id,
});
const memberRow = (column: "userId" | "agentId", value: string) => ({
  table: "conversation_members",
  column,
  value,
});
const eachSend: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };

const environment = defineEmitterCases([
  emitterCase({
    type: "workspace.public_channel_created",
    label: "a person creates a channel",
    setup: async () => ({ id: "", name: `made-${unique()}` }),
    act: async (env, fixture, made) => {
      made.id = (await channels(env).create(fixture.workspace.id, fixture.owner.id, made.name)).id;
    },
    data: (_fixture, made) => ({ channel_id: made.id, name: made.name }),
    refuse: conversationsOf,
  }),
  emitterCase({
    type: "workspace.public_channel_created",
    label: "an Agent creates a channel",
    setup: async (env, fixture) => ({
      agent: await agentIn(env, fixture),
      id: "",
      name: `made-${unique()}`,
    }),
    act: async (env, fixture, made) => {
      const created = await agentChannels(env).create(
        fixture.workspace.id,
        made.agent.id,
        made.name,
        undefined,
      );
      made.id = created.channel.id;
    },
    data: (_fixture, made) => ({ channel_id: made.id, name: made.name }),
    refuse: conversationsOf,
  }),
  emitterCase({
    type: "channel.member_added",
    label: "the creator of a new channel",
    // The Workspace Memory Agent joins every new channel, which is told too.
    others: 1,
    setup: async () => ({ id: "" }),
    act: async (env, fixture, made) => {
      made.id = (
        await channels(env).create(fixture.workspace.id, fixture.owner.id, `m-${unique()}`)
      ).id;
    },
    data: (fixture, made) => ({ channel_id: made.id, user_id: fixture.owner.id }),
    refuse: conversationsOf,
  }),
  emitterCase({
    type: "channel.member_added",
    label: "a person joins",
    setup: async (env, fixture) => ({
      channel: await channelOf(env, fixture),
      user: await personIn(env, fixture),
    }),
    act: (env, fixture, { channel, user }) =>
      channels(env).join(fixture.workspace.id, user.id, channel.id),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => memberRow("userId", user.id),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "addMembers adds a person",
    setup: async (env, fixture) => ({
      channel: await channelOf(env, fixture),
      user: await personIn(env, fixture),
    }),
    act: (env, fixture, { channel, user }) =>
      channels(env).addMembers(fixture.workspace.id, { userId: fixture.owner.id }, channel.id, {
        userIds: [user.id],
        agentIds: [],
      }),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => memberRow("userId", user.id),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "addMembers adds an Agent",
    setup: async (env, fixture) => ({
      channel: await channelOf(env, fixture),
      agent: await agentIn(env, fixture),
    }),
    act: (env, fixture, { channel, agent }) =>
      channels(env).addMembers(fixture.workspace.id, { userId: fixture.owner.id }, channel.id, {
        userIds: [],
        agentIds: [agent.id],
      }),
    data: (_fixture, { channel, agent }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow("agentId", agent.id),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "an Agent joins by itself",
    setup: async (env, fixture) => ({
      channel: await channelOf(env, fixture),
      agent: await agentIn(env, fixture),
    }),
    act: (env, fixture, { channel, agent }) =>
      agentChannels(env).join(fixture.workspace.id, agent.id, `#${channel.channelName}`),
    data: (_fixture, { channel, agent }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow("agentId", agent.id),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "an Agent joins by sending to the channel",
    setup: async (env, fixture) => ({
      channel: await channelOf(env, fixture),
      agent: await agentIn(env, fixture),
    }),
    act: (env, fixture, { channel, agent }) =>
      new SendDirectMessage(
        new PrismaDirectConversationRepository(env.db),
        { execute: async (_scope: unknown, persist: () => unknown) => persist() },
        { publish: async () => [] } as never,
      ).executeFromAgent({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: `#${channel.channelName}`,
        body: "hello",
      }),
    data: (_fixture, { channel, agent }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow("agentId", agent.id),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "a joiner is enrolled in #general",
    setup: async (env, fixture) => {
      // The Workspace's `#general` as creation leaves it, with the owner in it.
      await env.db.conversation.create({
        data: {
          workspaceId: fixture.workspace.id,
          channelName: "general",
          members: { create: { userId: fixture.owner.id } },
        },
      });
      const suffix = unique();
      return {
        user: await env.db.user.create({
          data: { displayName: `emit-j-${suffix}`, username: `emit-j-${suffix}` },
        }),
        generalId: "",
      };
    },
    act: async (env, fixture, joiner) => {
      await env.db.$transaction((tx) =>
        admitWorkspaceMember(tx, {
          workspace: fixture.workspace,
          userId: joiner.user.id,
          role: "member",
        }),
      );
      joiner.generalId = (
        await env.db.conversation.findFirstOrThrow({
          where: { workspaceId: fixture.workspace.id, channelName: "general" },
        })
      ).id;
    },
    data: (_fixture, joiner) => ({ channel_id: joiner.generalId, user_id: joiner.user.id }),
    refuse: (_fixture, joiner) => ({
      table: "workspace_memberships",
      column: "userId",
      value: joiner.user.id,
    }),
  }),
  emitterCase({
    type: "channel.member_added",
    label: "an Agent that became public is enrolled in #general",
    setup: async (env, fixture) => ({ agent: await agentIn(env, fixture), generalId: "" }),
    act: async (env, fixture, enrolled) => {
      enrolled.generalId = await env.db.$transaction((tx) =>
        joinGeneralChannel(tx, fixture.workspace.id, enrolled.agent.id),
      );
    },
    data: (_fixture, enrolled) => ({ channel_id: enrolled.generalId, agent_id: enrolled.agent.id }),
    refuse: (_fixture, { agent }) => memberRow("agentId", agent.id),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "a person leaves",
    setup: async (env, fixture) => {
      const channel = await channelOf(env, fixture);
      const user = await personIn(env, fixture);
      await channels(env).join(fixture.workspace.id, user.id, channel.id);
      return { channel, user };
    },
    act: (env, fixture, { channel, user }) =>
      channels(env).leave(fixture.workspace.id, user.id, channel.id),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => memberRow("userId", user.id),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "an admin removes a person",
    setup: async (env, fixture) => {
      const channel = await channelOf(env, fixture);
      const user = await personIn(env, fixture);
      await channels(env).join(fixture.workspace.id, user.id, channel.id);
      return { channel, user };
    },
    act: (env, fixture, { channel, user }) =>
      channels(env).removeMember(fixture.workspace.id, fixture.owner.id, channel.id, {
        userId: user.id,
      }),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => memberRow("userId", user.id),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "an Agent leaves by itself",
    setup: async (env, fixture) => {
      const channel = await channelOf(env, fixture);
      const agent = await agentIn(env, fixture);
      await agentChannels(env).join(fixture.workspace.id, agent.id, `#${channel.channelName}`);
      return { channel, agent };
    },
    act: (env, fixture, { channel, agent }) =>
      agentChannels(env).leave(fixture.workspace.id, agent.id, `#${channel.channelName}`),
    data: (_fixture, { channel, agent }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow("agentId", agent.id),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "a person leaves the Workspace",
    setup: async (env, fixture) => {
      const channel = await channelOf(env, fixture);
      const user = await personIn(env, fixture);
      await channels(env).join(fixture.workspace.id, user.id, channel.id);
      return { channel, user };
    },
    act: (env, fixture, { user }) =>
      workspaceMemberDirectory(env.db).leave({
        workspaceId: fixture.workspace.id,
        userId: user.id,
      }),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => memberRow("userId", user.id),
  }),
  emitterCase({
    type: "channel.config_updated",
    label: "a rename",
    setup: (env, fixture) => channelOf(env, fixture),
    act: (env, fixture, channel) =>
      channels(env).updateInfo(fixture.workspace.id, { userId: fixture.owner.id }, channel.id, {
        name: "renamed",
      }),
    data: (_fixture, channel) => ({ channel_id: channel.id, fields: ["name"], name: "renamed" }),
    refuse: (_fixture, channel) => ({ table: "conversations", column: "id", value: channel.id }),
  }),
  emitterCase({
    type: "channel.config_updated",
    label: "a new description",
    setup: (env, fixture) => channelOf(env, fixture),
    act: (env, fixture, channel) =>
      channels(env).updateInfo(fixture.workspace.id, { userId: fixture.owner.id }, channel.id, {
        description: "what it is for",
      }),
    data: (_fixture, channel) => ({ channel_id: channel.id, fields: ["description"] }),
    refuse: (_fixture, channel) => ({ table: "conversations", column: "id", value: channel.id }),
  }),
  ...(["workspace.public_channel_archived", "channel.archived"] as const).map((type) =>
    emitterCase({
      type,
      label: "archiving",
      setup: (env, fixture) => channelOf(env, fixture),
      act: (env, fixture, channel) =>
        channels(env).setArchived(
          fixture.workspace.id,
          { userId: fixture.owner.id },
          channel.id,
          true,
        ),
      data: (_fixture, channel) => ({ channel_id: channel.id }),
      refuse: (_fixture, channel) => ({ table: "conversations", column: "id", value: channel.id }),
    }),
  ),
  emitterCase({
    type: "thread.created",
    label: "a person's first reply",
    setup: threadable,
    act: (env, fixture, { channel, root }) =>
      channels(env, eachSend).send({
        workspaceId: fixture.workspace.id,
        userId: fixture.owner.id,
        channelId: channel.id,
        idempotencyKey: crypto.randomUUID(),
        body: "first reply",
        threadRootId: root.id,
      }),
    data: (_fixture, { channel, root }) => ({
      channel_id: channel.id,
      thread_root_id: root.id,
      message_id: expect.any(String),
    }),
    refuse: (_fixture, { channel }) => ({
      table: "messages",
      column: "conversationId",
      value: channel.id,
    }),
  }),
  emitterCase({
    type: "thread.created",
    label: "an Agent's first reply",
    setup: threadable,
    act: (env, _fixture, { channel, agent, root }) =>
      new PrismaDirectConversationRepository(env.db).sendAgentMessage(
        channel.id,
        agent.id,
        "first reply",
        undefined,
        root.id,
      ),
    data: (_fixture, { channel, root }) => ({
      channel_id: channel.id,
      thread_root_id: root.id,
      message_id: expect.any(String),
    }),
    refuse: (_fixture, { channel }) => ({
      table: "messages",
      column: "conversationId",
      value: channel.id,
    }),
  }),
]);

const testWithDatabase = emitterDatabaseUrl ? test : test.skip;

testWithDatabase("only the reply that makes the thread records thread.created", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const { channel, root } = await threadable(env, fixture);
    for (const body of ["first", "second"])
      await channels(env, eachSend).send({
        workspaceId: fixture.workspace.id,
        userId: fixture.owner.id,
        channelId: channel.id,
        idempotencyKey: crypto.randomUUID(),
        body,
        threadRootId: root.id,
      });
    expect(await env.recorded(fixture.workspace.id, "thread.created")).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

testWithDatabase(
  "nothing is recorded for no change: unarchiving, re-joining, a repeat add",
  async () => {
    const env = environment();
    const fixture = await env.fixture();
    try {
      const channel = await channelOf(env, fixture);
      const user = await personIn(env, fixture);
      const owner = { userId: fixture.owner.id };
      await channels(env).join(fixture.workspace.id, user.id, channel.id);
      await channels(env).setArchived(fixture.workspace.id, owner, channel.id, true);
      await channels(env).setArchived(fixture.workspace.id, owner, channel.id, false);
      await channels(env).join(fixture.workspace.id, user.id, channel.id);
      await channels(env).addMembers(fixture.workspace.id, owner, channel.id, {
        userIds: [user.id],
        agentIds: [],
      });
      await channels(env).updateInfo(fixture.workspace.id, owner, channel.id, {
        name: channel.channelName!,
      });
      const count = async (type: Parameters<typeof env.recorded>[1]) =>
        (await env.recorded(fixture.workspace.id, type)).length;
      // One join, one archive of each kind; the rest changed nothing.
      expect(await count("channel.member_added")).toBe(1);
      expect(await count("channel.archived")).toBe(1);
      expect(await count("workspace.public_channel_archived")).toBe(1);
      expect(await count("channel.config_updated")).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);
