import { expect, test } from "bun:test";

import { resolveAgentProfileUpdate } from "#src/server/agents/agent-profile.server";
import { AgentMascots } from "#src/server/agents/agent-mascot.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import {
  defineEmitterCases,
  emitterCase,
  type EmitterFixture,
} from "./helpers/app-notification-emitter-cases";
import { emitterDatabaseUrl, type EmitterEnvironment } from "./helpers/app-notification-emitters";

/**
 * The Agent events apps are notified of, against local PostgreSQL: each is recorded by the real
 * domain operation, in its transaction (see `helpers/app-notification-emitter-cases.ts`). Skipped
 * unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const unique = () => crypto.randomUUID().slice(0, 8);

/** An Agent of the fixture's Workspace on a Computer linked to it, running `pi` on model `m1`. */
async function agentOf(env: EmitterEnvironment, fixture: EmitterFixture) {
  const computer = await env.db.computer.create({
    data: { ownerId: fixture.owner.id, machineId: `emit-${unique()}` },
  });
  await env.db.workspaceComputer.create({
    data: { workspaceId: fixture.workspace.id, computerId: computer.id },
  });
  return env.db.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.owner.id,
      computerId: computer.id,
      name: `emit-a-${unique()}`,
      displayName: "Emit",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "m1",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
}

/** `ManageAgents` as the Web composes it, with the runtime control and the check that the Computer
 * can run the selection stubbed (no daemon). */
const manage = (env: EmitterEnvironment) =>
  new ManageAgents(
    new PrismaAgentRepository(env.db),
    { start: async () => {}, stop: async () => {} },
    { canRun: async () => true },
    { run: async (_agentId, callback) => callback() },
  );

type Edit = { provider?: "pi" | "codex"; model?: string; description?: string; reasoning?: string };
const edit = (
  env: EmitterEnvironment,
  fixture: EmitterFixture,
  agentId: string,
  { provider = "pi", model = "m1", description = "", reasoning }: Edit,
) =>
  manage(env).update(
    { userId: fixture.owner.id, workspaceId: fixture.workspace.id },
    { agentId, displayName: "Emit", description, provider, model, reasoning },
  );

const agentRow = (agentId: string) => ({ table: "agents", column: "id", value: agentId });

const environment = defineEmitterCases([
  emitterCase({
    type: "agent.profile_updated",
    label: "the owner edits the description",
    setup: agentOf,
    act: (env, fixture, agent) => edit(env, fixture, agent.id, { description: "does things" }),
    data: (_fixture, agent) => ({ agent_id: agent.id, fields: ["description"] }),
    refuse: (_fixture, agent) => agentRow(agent.id),
  }),
  emitterCase({
    type: "agent.profile_updated",
    label: "the Agent edits its own profile",
    setup: agentOf,
    act: (env, fixture, agent) =>
      resolveAgentProfileUpdate(
        env.db,
        { workspaceId: fixture.workspace.id, agentId: agent.id },
        { displayName: "Renamed" },
      ),
    data: (_fixture, agent) => ({ agent_id: agent.id, fields: ["display_name"] }),
    refuse: (_fixture, agent) => agentRow(agent.id),
  }),
  emitterCase({
    type: "agent.profile_updated",
    label: "the owner picks a mascot",
    setup: agentOf,
    act: (env, fixture, agent) =>
      new AgentMascots(env.db).set(fixture.workspace.id, fixture.owner.id, agent.id, "pink"),
    data: (_fixture, agent) => ({ agent_id: agent.id, fields: ["avatar"] }),
    refuse: (_fixture, agent) => agentRow(agent.id),
  }),
  emitterCase({
    type: "agent.runtime_changed",
    label: "the owner switches runtime",
    setup: agentOf,
    act: (env, fixture, agent) => edit(env, fixture, agent.id, { provider: "codex" }),
    data: (_fixture, agent) => ({ agent_id: agent.id, previous_runtime: "pi", runtime: "codex" }),
    refuse: (_fixture, agent) => agentRow(agent.id),
  }),
  emitterCase({
    type: "agent.model_changed",
    label: "the owner picks another model",
    setup: agentOf,
    act: (env, fixture, agent) => edit(env, fixture, agent.id, { model: "m2" }),
    data: (_fixture, agent) => ({
      agent_id: agent.id,
      fields: ["model"],
      previous_model: "m1",
      model: "m2",
    }),
    refuse: (_fixture, agent) => agentRow(agent.id),
  }),
]);

const testWithDatabase = emitterDatabaseUrl ? test : test.skip;

testWithDatabase("an edit records only the events of what it changed", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const agent = await agentOf(env, fixture);
    const count = async (type: Parameters<typeof env.recorded>[1]) =>
      (await env.recorded(fixture.workspace.id, type)).length;
    // Nothing changed.
    await edit(env, fixture, agent.id, {});
    // Only the model, only the reasoning: never the runtime or the profile.
    await edit(env, fixture, agent.id, { model: "m2" });
    await edit(env, fixture, agent.id, { model: "m2", reasoning: "high" });
    expect(await count("agent.model_changed")).toBe(2);
    expect(await count("agent.runtime_changed")).toBe(0);
    expect(await count("agent.profile_updated")).toBe(0);
    // A new runtime with a new model is both.
    await edit(env, fixture, agent.id, { provider: "codex", model: "m3", reasoning: "high" });
    expect(await count("agent.runtime_changed")).toBe(1);
    expect(await count("agent.model_changed")).toBe(3);
    const [event] = await env.recorded(fixture.workspace.id, "agent.runtime_changed");
    // Ids and names only: the stored configuration (its key, its environment) is never sent.
    expect(JSON.stringify(event)).not.toContain('provider":{');
  } finally {
    await fixture.cleanup();
  }
});
