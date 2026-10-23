import { expect, test } from "bun:test";
import { decodeAgentStartIntent, decodeAgentStopIntent } from "@lrm/coforge-sdk/internal";

import { AgentControl } from "#src/server/agents/agent-control.server";
import { agentStartIntent } from "#src/server/agents/manage-agents.server";
import { recordComputerObservation } from "#src/server/computers/computer-metadata.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import {
  defineEmitterCases,
  emitterCase,
  type EmitterFixture,
} from "./helpers/app-notification-emitter-cases";
import { emitterDatabaseUrl, type EmitterEnvironment } from "./helpers/app-notification-emitters";

/**
 * The Computer events apps are notified of, against local PostgreSQL: each is recorded by the real
 * domain operation, in its transaction (see `helpers/app-notification-emitter-cases.ts`). Skipped
 * unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const unique = () => crypto.randomUUID().slice(0, 8);

/** A Computer of the fixture's owner, linked to its Workspace, last reporting `version`. */
async function computerOf(env: EmitterEnvironment, fixture: EmitterFixture, version?: string) {
  const computer = await env.db.computer.create({
    data: {
      ownerId: fixture.owner.id,
      machineId: `emit-${unique()}`,
      ...(version ? { computerVersion: version, metadataStartedAt: 1n } : {}),
    },
  });
  await env.db.workspaceComputer.create({
    data: { workspaceId: fixture.workspace.id, computerId: computer.id },
  });
  return computer;
}

async function agentOn(env: EmitterEnvironment, fixture: EmitterFixture) {
  const computer = await computerOf(env, fixture);
  const agent = await env.db.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.owner.id,
      computerId: computer.id,
      name: `emit-a-${unique()}`,
      displayName: "Emit",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  return { computer, agent };
}

/**
 * The real `AgentControl` over the real store, with a Computer that answers every command at once:
 * a Start with `started`, a Stop with `stopped`. `settled()` waits for the answers to be stored.
 */
function controlFor(env: EmitterEnvironment, fixture: EmitterFixture) {
  const answers: Promise<void>[] = [];
  let sequence = 0;
  const control: AgentControl = new AgentControl(
    new PrismaAgentControlStore(env.db),
    {
      async publish(_channel, bytes) {
        const start = (() => {
          try {
            return decodeAgentStartIntent(bytes);
          } catch {
            return undefined;
          }
        })();
        const intent = start ?? decodeAgentStopIntent(bytes);
        const answered = Bun.sleep(0).then(() =>
          control.result(
            { workspaceId: fixture.workspace.id, computerId: intent.computerId },
            {
              ...intent,
              provider: intent.provider!,
              epoch: intent.controlEpoch!,
              phase: start ? "started" : "stopped",
              sequence: ++sequence,
              ...(start ? { launchId: start.launchId } : {}),
            },
          ),
        );
        // The test sees a refused commit through `settled`, not as an unhandled rejection.
        answered.catch(() => {});
        answers.push(answered);
      },
    },
    { run: (_agentId, work) => work() },
    { timeoutMs: 1_000 },
  );
  return { control, settled: () => Promise.all(answers) };
}

const environment = defineEmitterCases([
  emitterCase({
    type: "computer.version_changed",
    label: "the Computer reports a new version",
    setup: (env, fixture) => computerOf(env, fixture, "1.0.0"),
    act: (env, fixture, computer) =>
      recordComputerObservation(
        env.db,
        { workspaceId: fixture.workspace.id, computerId: computer.id },
        { computerVersion: "2.0.0", startedAt: 2 },
      ),
    data: (_fixture, computer) => ({
      computer_id: computer.id,
      previous_version: "1.0.0",
      version: "2.0.0",
    }),
    refuse: (_fixture, computer) => ({ table: "computers", column: "id", value: computer.id }),
  }),
  emitterCase({
    type: "computer.agent_started",
    label: "the Computer reports the Agent started",
    setup: agentOn,
    act: async (env, fixture, { agent }) => {
      const { control, settled } = controlFor(env, fixture);
      const record = await new PrismaAgentRepository(env.db).getById(agent.id);
      await control.publishStart(agentStartIntent(record!), fixture.owner.id);
      await settled();
    },
    data: (_fixture, { computer, agent }) => ({ computer_id: computer.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => ({
      table: "agents",
      updateWhen: `NEW."id" = '${agent.id}' AND NEW."controlState"->>'phase' = 'completed'`,
    }),
  }),
  emitterCase({
    type: "computer.agent_stopped",
    label: "the Computer reports the Agent stopped",
    setup: agentOn,
    act: async (env, fixture, { agent }) => {
      const { control, settled } = controlFor(env, fixture);
      // A Stop whose answer could not be stored never completes; the answer's own failure is the
      // one to report.
      const stop = await control
        .publishStop(
          { agentId: agent.id, workspaceId: fixture.workspace.id, requestId: crypto.randomUUID() },
          fixture.owner.id,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await settled();
      if (stop) throw stop;
    },
    data: (_fixture, { computer, agent }) => ({ computer_id: computer.id, agent_id: agent.id }),
    refuse: (_fixture, { agent }) => ({
      table: "agents",
      updateWhen: `NEW."id" = '${agent.id}' AND NEW."controlState"->>'phase' = 'stopped'`,
    }),
  }),
]);

const testWithDatabase = emitterDatabaseUrl ? test : test.skip;

testWithDatabase(
  "a version change is told to every Workspace the Computer is in, once, and a first report is not a change",
  async () => {
    const env = environment();
    const first = await env.fixture();
    const second = await env.fixture();
    try {
      const computer = await computerOf(env, first);
      await env.db.workspaceComputer.create({
        data: { workspaceId: second.workspace.id, computerId: computer.id },
      });
      const observe = (version: string, startedAt: number, workspaceId = first.workspace.id) =>
        recordComputerObservation(
          env.db,
          { workspaceId, computerId: computer.id },
          { computerVersion: version, startedAt },
        );
      await observe("1.0.0", 1);
      await observe("2.0.0", 2);
      // The other Workspace's daemon reports the same version, and the same version again.
      await observe("2.0.0", 3, second.workspace.id);
      await observe("2.0.0", 4);
      for (const { workspace } of [first, second]) {
        const events = await env.recorded(workspace.id, "computer.version_changed");
        expect(events.map((event) => event.data)).toEqual([
          { computer_id: computer.id, previous_version: "1.0.0", version: "2.0.0" },
        ]);
      }
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  },
);

testWithDatabase("a restart is a stop and then a start, and a plain start is no stop", async () => {
  const env = environment();
  const fixture = await env.fixture();
  try {
    const { agent } = await agentOn(env, fixture);
    const { control, settled } = controlFor(env, fixture);
    await control.execute({
      userId: fixture.owner.id,
      workspaceId: fixture.workspace.id,
      agentId: agent.id,
      requestId: crypto.randomUUID(),
      action: "restart",
    });
    await settled();
    expect(await env.recorded(fixture.workspace.id, "computer.agent_stopped")).toHaveLength(1);
    expect(await env.recorded(fixture.workspace.id, "computer.agent_started")).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});
