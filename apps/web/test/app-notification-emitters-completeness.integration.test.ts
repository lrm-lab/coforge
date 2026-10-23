import { expect, test } from "bun:test";

import { AgentAvatars } from "#src/server/agents/agent-avatar.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { createOwnedWorkspace } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import { attachDefaultMemoryAgent } from "#src/server/workspace-memory/default-memory-agent.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { defineEmitterCases, emitterCase } from "./helpers/app-notification-emitter-cases";
import { agentIn, channelOf, personIn, unique } from "./helpers/app-notification-emitter-domain";
import { emitterDatabaseUrl } from "./helpers/app-notification-emitters";

/**
 * The write paths that are easy to miss, against local PostgreSQL: the Workspace Memory Agent
 * joining a channel, the weekly-report assistant's rename, `#general` coming to exist, an Agent
 * administrator removing a person, and a picture removed (see
 * `helpers/app-notification-emitter-cases.ts`). Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL`
 * points at local PostgreSQL.
 */

const environment = defineEmitterCases([
  emitterCase({
    type: "channel.member_added",
    label: "the Workspace Memory Agent joins a new channel",
    setup: async (env, fixture) => ({ channel: await channelOf(env, fixture), memoryAgentId: "" }),
    act: async (env, fixture, made) => {
      await attachDefaultMemoryAgent(env.db, {
        workspaceId: fixture.workspace.id,
        conversationId: made.channel.id,
        actorUserId: fixture.owner.id,
        now: new Date(),
        gate: { prototypeEnabled: false },
      });
      made.memoryAgentId = (
        await env.db.workspaceMemoryAgent.findUniqueOrThrow({
          where: { workspaceId: fixture.workspace.id },
        })
      ).agentId;
    },
    data: (_fixture, made) => ({ channel_id: made.channel.id, agent_id: made.memoryAgentId }),
    refuse: (fixture) => ({
      table: "conversation_members",
      column: "workspaceId",
      value: fixture.workspace.id,
    }),
  }),
  emitterCase({
    type: "agent.profile_updated",
    label: "the weekly-report assistant is renamed after its owner",
    setup: async (env, fixture) => {
      const agent = await agentIn(env, fixture);
      await env.db.weeklyReportAssistant.create({
        data: { workspaceId: fixture.workspace.id, userId: fixture.owner.id, agentId: agent.id },
      });
      return agent;
    },
    act: (env, fixture) =>
      new WorkspaceMembers(env.db).agentPage(fixture.workspace.id, fixture.owner.id, {
        owner: "all",
        query: "",
        limit: 20,
      }),
    data: (_fixture, agent) => ({ agent_id: agent.id, fields: ["display_name"] }),
    refuse: (_fixture, agent) => ({ table: "agents", column: "id", value: agent.id }),
  }),
  emitterCase({
    type: "workspace.public_channel_created",
    label: "#general is created by enrollment",
    setup: async () => ({ id: "" }),
    act: async (env, fixture, general) => {
      general.id = (
        await env.db.$transaction((tx) => enrollGeneralChannel(tx, fixture.workspace.id))
      ).id;
    },
    data: (_fixture, general) => ({ channel_id: general.id, name: "general" }),
    refuse: (fixture) => ({
      table: "conversations",
      column: "workspaceId",
      value: fixture.workspace.id,
    }),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "an Agent administrator removes a person",
    setup: async (env, fixture) => {
      const channel = await channelOf(env, fixture);
      const user = await personIn(env, fixture);
      const agent = await agentIn(env, fixture);
      await env.db.conversationMember.createMany({
        data: [
          { conversationId: channel.id, workspaceId: fixture.workspace.id, userId: user.id },
          {
            conversationId: channel.id,
            workspaceId: fixture.workspace.id,
            agentId: agent.id,
            channelRole: "admin",
          },
        ],
      });
      return { channel, user, agent };
    },
    act: (env, fixture, { channel, user, agent }) =>
      new AgentChannelManagement(env.db, undefined, undefined, undefined, {
        purge: async () => {},
      }).removeMember(fixture.workspace.id, agent.id, `#${channel.channelName}`, {
        user: `@${user.username}`,
      }),
    data: (_fixture, { channel, user }) => ({ channel_id: channel.id, user_id: user.id }),
    refuse: (_fixture, { user }) => ({
      table: "conversation_members",
      column: "userId",
      value: user.id,
    }),
  }),
  emitterCase({
    type: "agent.profile_updated",
    label: "the owner removes the picture",
    setup: async (env, fixture) => {
      const agent = await agentIn(env, fixture);
      await env.db.agent.update({
        where: { id: agent.id },
        data: { avatarObjectKey: `agents/${agent.id}/a`, avatarContentType: "image/png" },
      });
      return agent;
    },
    act: (env, fixture, agent) =>
      new AgentAvatars(env.db, async () => ({
        put: async () => {},
        open: async () => null,
        remove: async () => {},
        head: async () => null,
      })).remove(fixture.workspace.id, fixture.owner.id, agent.id),
    data: (_fixture, agent) => ({ agent_id: agent.id, fields: ["avatar"] }),
    refuse: (_fixture, agent) => ({ table: "agents", column: "id", value: agent.id }),
  }),
]);

const testWithDatabase = emitterDatabaseUrl ? test : test.skip;

testWithDatabase("a new Workspace tells its apps its #general and the creator in it", async () => {
  const env = environment();
  const slug = env.onSlug();
  const owner = await env.db.user.create({
    data: { displayName: `emit-o-${unique()}`, username: `emit-o-${unique()}` },
  });
  let workspaceId: string | undefined;
  try {
    const created = await createOwnedWorkspace(
      env.db,
      { slug, name: "Fresh", userId: owner.id },
      { id: true },
    );
    workspaceId = created.id;
    const general = await env.db.conversation.findFirstOrThrow({
      where: { workspaceId, channelName: "general" },
    });
    const made = await env.recorded(workspaceId, "workspace.public_channel_created");
    expect(made.map((event) => event.data)).toEqual([{ channel_id: general.id, name: "general" }]);
    const joined = await env.recorded(workspaceId, "channel.member_added");
    expect(joined.map((event) => event.data)).toEqual([
      { channel_id: general.id, user_id: owner.id },
    ]);
  } finally {
    if (workspaceId) await env.db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    await env.db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
  }
});
