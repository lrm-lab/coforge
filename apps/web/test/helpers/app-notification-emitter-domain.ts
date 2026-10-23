import type { EmitterFixture } from "./app-notification-emitter-cases";
import type { EmitterEnvironment } from "./app-notification-emitters";

/** Rows the emitter suites act on: a Workspace's channel, person and Agent. */
export const unique = () => crypto.randomUUID().slice(0, 8);

/** A channel the fixture's owner administers. */
export async function channelOf(env: EmitterEnvironment, fixture: EmitterFixture) {
  return env.db.conversation.create({
    data: {
      workspaceId: fixture.workspace.id,
      channelName: `chan-${unique()}`,
      members: { create: { userId: fixture.owner.id, channelRole: "admin" } },
    },
  });
}

/** A member of the Workspace who is not in any channel. */
export async function personIn(env: EmitterEnvironment, fixture: EmitterFixture) {
  const suffix = unique();
  const user = await env.db.user.create({
    data: { displayName: `emit-p-${suffix}`, username: `emit-p-${suffix}` },
  });
  await env.db.workspaceMembership.create({
    data: { workspaceId: fixture.workspace.id, userId: user.id, role: "member" },
  });
  return user;
}

/** A public Agent of the Workspace, in no channel. */
export function agentIn(env: EmitterEnvironment, fixture: EmitterFixture) {
  const suffix = unique();
  return env.db.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.owner.id,
      name: `emit-a-${suffix}`,
      displayName: "Emit",
      runtimeConfig: {},
    },
  });
}
