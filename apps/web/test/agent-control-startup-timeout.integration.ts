import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { startupDeadlineMs } from "@lrm/coforge-sdk/internal";
import { agentControlRevision } from "#src/server/agents/agent-control.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import {
  AgentControlStartupTimeout,
  STARTUP_DEADLINE_ERROR_CODE,
} from "#src/server/agents/agent-control-startup-timeout.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";

function database() {
  const connectionString = Bun.env.AGENT_SESSION_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("AGENT_SESSION_TEST_DATABASE_URL is required (local PostgreSQL)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const storedConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};
const STARTED = 1_800_000_000_000;

async function seedStarting(db: PrismaClient) {
  const fixture = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `to-${fixture}`, username: `to-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: `to-${fixture}`, name: "Timeout", members: { create: { userId: owner.id } } },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `to-${fixture}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "timeout",
      displayName: "Timeout",
      runtimeConfig: storedConfig,
    },
  });
  await db.agent.update({
    where: { id: agent.id },
    data: {
      controlState: {
        version: 1,
        protocolMajor: 1,
        requestId: fixture,
        workspaceId: workspace.id,
        computerId: computer.id,
        agentId: agent.id,
        provider: "pi",
        epoch: 1,
        action: "start",
        phase: "starting",
        configRevision: agentControlRevision(parseAgentRuntimeConfig(storedConfig)),
        launchId: "launch-a",
        controlSequence: 0,
        sessionSequence: 0,
        startedAtMs: STARTED,
        deadlineAtMs: STARTED + startupDeadlineMs("pi"),
      },
    },
  });
  return agent;
}

function timeoutOver(db: PrismaClient, online: boolean, events: unknown[]) {
  return new AgentControlStartupTimeout({
    store: new PrismaAgentControlStore(db),
    signal: new LocalAgentControlSignal(),
    events: { publish: (_agent: unknown, event: unknown) => void events.push(event) } as never,
    runtimeLock: { run: async (_id, work) => work() },
    sendStop: async () => {},
    computerOnline: async () => online,
    clock: () => STARTED + startupDeadlineMs("pi") + 1,
  });
}

test("two sweeps racing on one expired launch settle it once and persist the failure", async () => {
  const db = database();
  const agent = await seedStarting(db);
  const events: unknown[] = [];
  const warn = console.warn;
  console.warn = () => {};
  let outcomes: string[];
  try {
    outcomes = await Promise.all([
      timeoutOver(db, false, events).settle(agent.id),
      timeoutOver(db, false, events).settle(agent.id),
    ]);
  } finally {
    console.warn = warn;
  }
  expect(outcomes.sort()).toEqual(["failed", "lost"]);
  expect(events).toHaveLength(1);
  const stored = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } }))
    .controlState as Record<string, unknown>;
  expect(stored).toMatchObject({
    phase: "failed",
    errorCode: STARTUP_DEADLINE_ERROR_CODE,
    failedStreak: 1,
  });
  expect(stored.stopSentAtMs).toBeUndefined();
});

test("an online Computer is sent a fenced Stop with the epoch bumped in the stored state", async () => {
  const db = database();
  const agent = await seedStarting(db);
  const outcome = await timeoutOver(db, true, []).settle(agent.id);
  expect(outcome).toBe("stop_sent");
  const stored = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } }))
    .controlState as Record<string, unknown>;
  expect(stored).toMatchObject({ phase: "starting", epoch: 2 });
  expect(stored.stopSentAtMs).toBeNumber();
});
