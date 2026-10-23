import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import {
  defineEmitterCases,
  emitterCase,
  type EmitterFixture,
} from "./helpers/app-notification-emitter-cases";
import type { EmitterEnvironment } from "./helpers/app-notification-emitters";

/**
 * The channel memberships an Agent loses when its own state changes, against local PostgreSQL: each
 * is recorded as `channel.member_removed` by the real domain operation, in its transaction (see
 * `helpers/app-notification-emitter-cases.ts`). Skipped unless
 * `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL.
 */

/** A public Agent that is a member of one channel. */
async function agentInChannel(env: EmitterEnvironment, fixture: EmitterFixture) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await env.db.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.owner.id,
      name: `emit-a-${suffix}`,
      displayName: "Emit",
      runtimeConfig: {},
    },
  });
  const channel = await env.db.conversation.create({
    data: {
      workspaceId: fixture.workspace.id,
      channelName: `chan-${suffix}`,
      members: {
        create: [{ userId: fixture.owner.id, channelRole: "admin" }, { agentId: agent.id }],
      },
    },
  });
  return { agent, channel };
}

const memberRow = (agentId: string) => ({
  table: "conversation_members",
  column: "agentId",
  value: agentId,
});

defineEmitterCases([
  emitterCase({
    type: "channel.member_removed",
    label: "an Agent goes private",
    setup: agentInChannel,
    act: (env, fixture, { agent }) =>
      new PrismaChangeAgentVisibilityStore(env.db).apply({
        agentId: agent.id,
        workspaceId: fixture.workspace.id,
        visibility: "private",
      }),
    data: (_fixture, { agent, channel }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow(agent.id),
  }),
  emitterCase({
    type: "channel.member_removed",
    label: "an Agent is deleted",
    setup: agentInChannel,
    act: (env, fixture, { agent }) =>
      new PrismaAgentDeletionStore(env.db).delete({
        agentId: agent.id,
        workspaceId: fixture.workspace.id,
        deletedAt: new Date(),
        deletedByUserId: fixture.owner.id,
      }),
    data: (_fixture, { agent, channel }) => ({ channel_id: channel.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => memberRow(agent.id),
  }),
]);
