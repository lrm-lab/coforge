import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  agentControlRevision,
  type AgentControlAgent,
} from "#src/server/agents/agent-control.server";
import { AgentControlReceiver } from "#src/server/agents/agent-control-receiver.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";

/**
 * A Daemon's terminal `failed` control result must always settle the operation: production
 * (task #18) saw every failed launch result rejected by a ZodError inside the state write —
 * `failedStreak` was added to `AgentControlState` but not to the persisted-state schema — so the
 * Agent stayed `starting` and the server resent the same Start every ten minutes. This drives
 * the real `AgentControlReceiver.result` against `PrismaAgentControlStore` on local PostgreSQL
 * with the production payload shape (`agent_authorization_failed` plus a long launch detail).
 * Needs `AGENT_SESSION_TEST_DATABASE_URL` pointing at local PostgreSQL.
 */
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

// The production detail the codec caps at MAX_VISIBLE_ERROR_CHARS (512): a launch-configuration
// refusal whose provider message runs long.
const LAUNCH_DETAIL =
  "Agent launch configuration could not be obtained: connect ECONNRESET 203.0.113.10:443 " +
  "(provider api). The Agent's launch credentials were refused; pass `verbose: true` to the " +
  "launch for the underlying provider error.".padEnd(500, " …");

async function seedStarting(db: PrismaClient) {
  const fixture = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `ctl-${fixture}`, username: `ctl-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `ctl-${fixture}`,
      name: "Control result",
      members: { create: { userId: owner.id } },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `ctl-${fixture}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "control",
      displayName: "Control",
      runtimeConfig: storedConfig,
    },
  });
  const controlState = {
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
  };
  await db.agent.update({ where: { id: agent.id }, data: { controlState } });
  return { agent, workspace, computer, requestId: fixture };
}

test("a failed launch result with a long detail settles the operation as failed", async () => {
  const db = database();
  const f = await seedStarting(db);
  const store = new PrismaAgentControlStore(db);
  const stopReasons: string[] = [];
  const receiver = new AgentControlReceiver(
    store,
    new LocalAgentControlSignal(),
    {} as never,
    undefined,
    async (_agent: Pick<AgentControlAgent, "id">, reason: string) => {
      stopReasons.push(reason);
    },
  );
  const claim = { workspaceId: f.workspace.id, computerId: f.computer.id };
  const result = {
    protocolMajor: 1,
    requestId: f.requestId,
    workspaceId: f.workspace.id,
    computerId: f.computer.id,
    agentId: f.agent.id,
    provider: "pi" as const,
    epoch: 1,
    phase: "failed" as const,
    sequence: 1,
    launchId: "launch-a",
    errorCode: "agent_authorization_failed",
    errorDetail: LAUNCH_DETAIL,
  };

  await receiver.result(claim, result);

  const settled = await store.get(f.agent.id);
  expect(settled?.state?.phase).toBe("failed");
  expect(settled?.state?.errorCode).toBe("agent_authorization_failed");
  expect(settled?.state?.failedStreak).toBe(1);
  expect(settled?.state?.failedAtMs).toBeNumber();
  expect(settled?.state?.controlSequence).toBe(1);
  const stored = (await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } }))
    .controlState as Record<string, unknown>;
  expect(stored.phase).toBe("failed");
  expect(stored.failedStreak).toBe(1);
  expect(stored.errorCode).toBe("agent_authorization_failed");
  expect(stopReasons).toEqual(["agent_authorization_failed"]);

  // The Daemon resends the same result after a dropped reply; the settled sequence answers it
  // without re-entering the transition.
  await receiver.result(claim, result);
  expect((await store.get(f.agent.id))?.state?.failedStreak).toBe(1);
});
