import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentConfigApply } from "#src/server/agents/agent-config-apply.server";
import { ControlFenceLostError } from "#src/server/agents/agent-config-plan.server";
import { agentControlRevision, current } from "#src/server/agents/agent-control-types.server";
import { AgentControlReceiver } from "#src/server/agents/agent-control-receiver.server";
import { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaAgentRuntimeCredentialRepository } from "#src/server/db/repositories/agent-runtime-credential.repositories.server";
import { PrismaAgentSessionRepository } from "#src/server/db/repositories/agent-session.repositories.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

/**
 * A config push re-fences the control state in the same transaction as the write. Only a real
 * database proves the row lock, the jsonb round trip of the hash, and that a non-push save leaves
 * the control state alone. Needs local PostgreSQL in `AGENT_SESSION_TEST_DATABASE_URL`.
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
  model: "old",
  reasoning: "high",
  environment: { keyId: "v1", nonce: "n", ciphertext: "c" },
};

async function seed(
  db: PrismaClient,
  options: { phase?: "completed" | "failed"; memoryAgent?: boolean } = {},
) {
  const fixture = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `fence-${fixture}`, username: `fence-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `fence-${fixture}`,
      name: "Fence test",
      members: { create: { userId: owner.id } },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `fence-${fixture}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "fence",
      displayName: "Fence",
      runtimeConfig: storedConfig,
    },
  });
  if (options.memoryAgent)
    await db.workspaceMemoryAgent.create({
      data: { workspaceId: workspace.id, agentId: agent.id },
    });
  const control = {
    version: 1,
    protocolMajor: 1,
    requestId: fixture,
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: agent.id,
    provider: "pi",
    epoch: 1,
    action: "start",
    phase: options.phase ?? "completed",
    configRevision: agentControlRevision(parseAgentRuntimeConfig(storedConfig)),
    launchId: "launch-a",
    controlSequence: 1,
    sessionSequence: 0,
    ...(options.phase === "failed" ? { errorCode: "launch_failed", failedAtMs: 1 } : {}),
  };
  await db.agent.update({ where: { id: agent.id }, data: { controlState: control } });
  const store = new PrismaAgentControlStore(db);
  const apply = new AgentConfigApply(
    { supports: async () => true, publish: async () => {} },
    store,
    new PrismaAgentSessionRepository(db),
  );
  const plan = () =>
    apply.plan(
      { id: agent.id, workspaceId: workspace.id, computerId: computer.id, stoppedAt: null },
      { changed: true },
    );
  const claim = { workspaceId: workspace.id, computerId: computer.id };
  return { agent, workspace, computer, control, store, plan, claim };
}

const read = async (db: PrismaClient, id: string) =>
  db.agent.findUniqueOrThrow({
    where: { id },
    select: { controlState: true, runtimeConfig: true, runtimeConfigRevision: true },
  });

test("a fenced push keeps the running launch current: only configRevision changes", async () => {
  const db = database();
  const f = await seed(db);
  const decision = await f.plan();
  expect(decision.plan).toBe("push");

  const agents = new PrismaAgentRepository(db);
  const updated = await agents.update(
    f.agent.id,
    {
      displayName: "Fence",
      description: "",
      runtimeConfig: { ...parseAgentRuntimeConfig(storedConfig), model: "new" },
    },
    decision.fence,
  );

  expect(updated.runtimeConfigRevision).toBe(1);
  const after = await f.store.get(f.agent.id);
  expect(after?.runtimeConfig.model).toBe("new");
  expect(current(after!, after!.state!)).toBe(true);
  const { configRevision: before, ...unchanged } = f.control;
  const { configRevision: now, ...rest } = (await read(db, f.agent.id)).controlState as Record<
    string,
    unknown
  >;
  expect(rest).toEqual(unchanged);
  expect(now).not.toBe(before);

  const scope = {
    protocolMajor: 1,
    requestId: f.control.requestId,
    ...f.claim,
    agentId: f.agent.id,
    provider: "pi" as const,
    epoch: 1,
  };
  await new AgentControlReceiver(f.store, {} as never, {} as never).authorizeLaunch({
    agentId: f.agent.id,
    ...f.claim,
    controlEpoch: 1,
    requestId: f.control.requestId,
    launchId: "launch-a",
  });
  const sessions = new AgentSessionReceiver(f.store, async () => "daemon-1", {
    resendForCurrentSession: async () => {},
  });
  await sessions.authorize(f.claim, {
    ...scope,
    sessionId: "native-1",
    startRequestId: f.control.requestId,
    daemonInstanceId: "daemon-1",
    launchId: "launch-a",
    controlEpoch: 1,
  });
  await sessions.accept(f.claim, {
    ...scope,
    launchId: "launch-a",
    sequence: 1,
    identity: { sessionId: "native-1", state: "resumable" },
  });
  expect((await f.store.get(f.agent.id))?.state?.identity?.sessionId).toBe("native-1");
});

test("a runtime credential push re-fences the same way", async () => {
  const db = database();
  const f = await seed(db);
  const decision = await f.plan();

  await new PrismaAgentRuntimeCredentialRepository(db).updateRuntimeConfig(
    f.agent.id,
    {
      ...parseAgentRuntimeConfig(storedConfig),
      provider: {
        kind: "coforge",
        providerId: "anthropic",
        apiKey: { keyId: "v1", ciphertext: "k", nonce: "n", hint: "••••1234" },
      },
    },
    decision.fence,
  );

  const after = await f.store.get(f.agent.id);
  expect((await read(db, f.agent.id)).runtimeConfigRevision).toBe(1);
  expect(current(after!, after!.state!)).toBe(true);
});

test("a control state that moved after the plan writes nothing", async () => {
  const db = database();
  const f = await seed(db);
  const decision = await f.plan();
  await db.agent.update({
    where: { id: f.agent.id },
    data: { controlState: { ...f.control, epoch: 2, requestId: "newer" } },
  });
  const moved = await read(db, f.agent.id);

  await expect(
    new PrismaAgentRepository(db).update(
      f.agent.id,
      {
        displayName: "Fence",
        description: "",
        runtimeConfig: { ...parseAgentRuntimeConfig(storedConfig), model: "new" },
      },
      decision.fence,
    ),
  ).rejects.toBeInstanceOf(ControlFenceLostError);

  expect(await read(db, f.agent.id)).toEqual(moved);
});

test("a failed launch is not pushed to and a save leaves its fence alone", async () => {
  const db = database();
  const f = await seed(db, { phase: "failed" });
  expect((await f.plan()).plan).toBe("restart");

  await new PrismaAgentRepository(db).update(f.agent.id, {
    displayName: "Fence",
    description: "",
    runtimeConfig: { ...parseAgentRuntimeConfig(storedConfig), model: "new" },
  });

  const after = await read(db, f.agent.id);
  expect(after.controlState).toEqual(f.control);
  expect(after.runtimeConfigRevision).toBe(1);
  // The control case: without a re-fence the new config is what makes the old state stale.
  const stale = await f.store.get(f.agent.id);
  expect(current(stale!, stale!.state!)).toBe(false);
});

test("a Workspace Memory Agent is never pushed to", async () => {
  const db = database();
  const f = await seed(db, { memoryAgent: true });
  expect((await f.plan()).plan).toBe("restart");
});
