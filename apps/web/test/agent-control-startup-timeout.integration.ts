import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { startupDeadlineMs } from "@lrm/coforge-sdk/internal";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import {
  AgentControlStartupTimeout,
  STARTUP_DEADLINE_ERROR_CODE,
} from "#src/server/agents/agent-control-startup-timeout.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import {
  database,
  seedAgentOnComputer,
  seedWorkspace,
  startingState,
} from "./helpers/agent-control-integration";

const STARTED = 1_800_000_000_000;

async function seedStarting(db: PrismaClient) {
  const base = await seedWorkspace(db);
  const agent = await seedAgentOnComputer(db, base, { name: "timeout" });
  await db.agent.update({
    where: { id: agent.id },
    data: {
      controlState: startingState(agent, crypto.randomUUID(), {
        launchId: "launch-a",
        startedAtMs: STARTED,
        deadlineAtMs: STARTED + startupDeadlineMs("pi"),
      }),
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
