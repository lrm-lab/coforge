import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { ComputerRegistrar } from "#src/server/computers/registration.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "#src/server/db/repositories/setup.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import {
  userAgentControl,
  userAgentRuntimeControl,
} from "#src/server/agents/user-agent-control.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  defaultCentrifugeWorkspaceClientFactory,
  startAgentProxy,
} from "@lrm/coforge-daemon";
import { PiJsonlFixtureProvider } from "@lrm/coforge-daemon/test/fixtures/pi-jsonl-fixture-provider";

const databaseUrl = requireEnvironment("DATABASE_URL");
if (requireEnvironment("COFORGE_E2E_ALLOW_RESET") !== "1")
  throw new Error("COFORGE_E2E_ALLOW_RESET=1 is required for destructive E2E cleanup");
const webUrl = "http://127.0.0.1:8789";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const workspaceSlug = "e2e-workspace";
const repositoryRoot = join(import.meta.dir, "../../..");
const workspaceRoot = join(repositoryRoot, ".amp/e2e/workspace-root");
const daemonStateDirectory = join(repositoryRoot, ".amp/e2e/daemon-state");
const artifactDirectory = join(repositoryRoot, ".amp/e2e/agent-introduction");
const fixture = join(
  repositoryRoot,
  "packages/daemon/test/fixtures/agent-introduction-e2e-runtime.ts",
);
const INTRODUCTION_MARKER = "You were just created in CoForge.";
const INTRODUCTION_BODY = "E2E introduction: I am ready.";
const DESCRIPTION = "Keeps the E2E release notes tidy";
/** The fixture logs an introduction prompt carrying this but never sends the DM. */
const SKIP_INTRODUCTION_MARKER = "[e2e: skip introduction]";
const STARTERS = [
  "Start.",
  [
    "You are back online. No new messages are pending.",
    "Use your existing session context first. If it does not establish your current work, read MEMORY.md and notes/active-context.md if present, and check unfinished tasks assigned to you once.",
    "Resume only actionable work already requested or assigned to you; do not invent work or scan unrelated channels and projects.",
    "If no actionable work remains, end this turn silently. Do not send a startup announcement or repeat your introduction.",
  ].join(" "),
];

type Turn = { pid: number; text: string };

test("a new Agent introduces itself to its creator by DM on its first start, until it lands", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(requireEnvironment("REDIS_URL"));
  const steps: string[] = [];
  const observations: Record<string, unknown> = {};
  const turnLogs: Record<string, Turn[]> = {};
  let outcome: "pass" | "fail" = "fail";
  let failure: string | undefined;

  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "agent_api_keys", "daemon_api_keys", "agent_message_deliveries", "messages", "conversation_members", "conversations", "agents", "workspace_computers", "computers", "workspace_memberships", "user_identities", "users", "workspaces", "attachments" CASCADE',
  );
  await redis.send("FLUSHDB", []);
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(daemonStateDirectory, { recursive: true, force: true });
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });

  await db.workspace.create({
    data: {
      id: workspaceId,
      slug: workspaceSlug,
      name: "E2E Workspace",
      members: {
        create: {
          role: "owner",
          user: {
            create: {
              id: DEV_BROWSER_USER.id,
              username: DEV_BROWSER_USER.username,
              // Without a display name the dev user is sent to the first-sign-in name step.
              displayName: DEV_BROWSER_USER.name,
            },
          },
        },
      },
    },
  });
  const registration = await new ComputerRegistrar({
    workspaceAccess: new PrismaWorkspaceAccess(db),
    registrations: new PrismaComputerRegistrationRepository(db),
  }).register(
    {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceSlug,
      name: "e2e-computer",
      displayName: "E2E Computer",
      machineId: "e2e-machine",
      platform: "linux",
      osVersion: "e2e",
      computerVersion: "0.1.0",
      registrationIdempotencyKey: "e2e-registration",
    },
    { userId: DEV_BROWSER_USER.id },
  );

  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(workspaceId, registration.computerId, registration.daemonApiKey);
  let runtime: DaemonRuntime | undefined;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      agentAttachment: (...args) => runtime!.agentRequests.agentAttachment(...args),
      inbox: (...args) => runtime!.inbox(...args),
      issueAgentContext: (agentId, context) => runtime!.issueAgentContext(agentId, context),
    },
  });
  const connection = {
    workspaceId,
    computerId: registration.computerId,
    workspaceRoot,
    serverHttpUrl: webUrl,
  };
  runtime = new DaemonRuntime(
    connection,
    () => new PiJsonlFixtureProvider([process.execPath, fixture]),
    credentials,
    {
      create: () =>
        new DaemonConnection(
          "ws://127.0.0.1:8000/connection/websocket",
          defaultCentrifugeWorkspaceClientFactory,
        ),
    },
    proxy,
    {
      runtimes: async () => [{ provider: "pi", version: "fixture", displayName: "Pi E2E fixture" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    daemonStateDirectory,
  );

  const agents = new PrismaAgentRepository(db);
  const control = userAgentControl(db);
  const agentDirectory = (agentId: string) => join(workspaceRoot, workspaceId, "agents", agentId);
  const turnsOf = async (agentId: string): Promise<Turn[]> => {
    const file = Bun.file(join(agentDirectory(agentId), ".e2e-turns.jsonl"));
    if (!(await file.exists())) return [];
    return (await file.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Turn);
  };
  const failIfFixtureFailed = async (agentId: string) => {
    const error = Bun.file(join(agentDirectory(agentId), ".e2e-agent-error"));
    if (await error.exists()) throw new Error(`fixture failed: ${await error.text()}`);
  };
  const introductionMessages = (agentId: string) =>
    db.message.findMany({
      where: {
        workspaceId,
        sender: { agentId },
        conversation: {
          directKey: { not: null },
          members: { some: { userId: DEV_BROWSER_USER.id } },
        },
      },
      orderBy: { sequence: "asc" },
      select: { id: true, body: true, conversationId: true, sequence: true, createdAt: true },
    });
  const dueAt = async (agentId: string) =>
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).introductionDueAt;

  const manageAgents = new ManageAgents(
    agents,
    userAgentRuntimeControl(db, agents),
    { canRun: async () => true },
    getAgentRuntimeLock(),
  );
  const createAgent = (name: string, description: string) =>
    manageAgents.create(
      { userId: DEV_BROWSER_USER.id, workspaceId, role: "owner" },
      {
        name,
        description,
        provider: "pi",
        computerId: registration.computerId,
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
    );
  /** The Web's Restart button; resolves with the new process's turns once its first one lands. */
  const restart = async (agentId: string) => {
    const before = new Set((await turnsOf(agentId)).map(({ pid }) => pid));
    const view = await control.execute({
      userId: DEV_BROWSER_USER.id,
      workspaceId,
      agentId,
      requestId: crypto.randomUUID(),
      action: "restart",
    });
    await waitFor(
      `restarted process's first turn (${agentId})`,
      async () => {
        await failIfFixtureFailed(agentId);
        return (await turnsOf(agentId)).some(({ pid }) => !before.has(pid));
      },
      20_000,
    );
    const turns = await turnsOf(agentId);
    const pid = turns.find(({ pid }) => !before.has(pid))!.pid;
    return { view, pid, turns: turns.filter((turn) => turn.pid === pid) };
  };

  let introducedAgentId: string | undefined;
  let systemAgentId: string | undefined;
  let unlandedAgentId: string | undefined;
  try {
    // The daemon is online first, so the create's own Start (publishStart -> sendStart) launches it.
    await runtime.start(connection);
    steps.push("daemon connected and ready over Centrifugo");

    // 1. A person creates an Agent with a description.
    const created = await createAgent("e2e-introducer", DESCRIPTION);
    const agentId = created.agent.id;
    introducedAgentId = agentId;
    expect(created.startPublished).toBe(true);
    const dueBefore = await dueAt(agentId);
    expect(dueBefore).toBeInstanceOf(Date);
    observations.agentId = agentId;
    observations.introductionDueAtBefore = dueBefore?.toISOString();
    steps.push("dev user created Agent @e2e-introducer through ManageAgents.create");

    // 2. The first turn of the first process is the introduction, in place of `Start.`.
    await waitFor("first turn", async () => {
      await failIfFixtureFailed(agentId);
      return (await turnsOf(agentId)).length > 0;
    });
    const firstTurns = await turnsOf(agentId);
    const firstPid = firstTurns[0]!.pid;
    const firstTurn = firstTurns[0]!.text;
    observations.introductionPromptExcerpt = firstTurn.slice(0, 400);
    expect(firstTurn.startsWith(INTRODUCTION_MARKER)).toBe(true);
    expect(firstTurn).toContain(`@${DEV_BROWSER_USER.username}`);
    expect(firstTurn).toContain(DESCRIPTION);
    steps.push("first process's first turn is the introduction prompt");

    // 3. The introduction lands in the creator's DM. The send settles nothing: the next Start does.
    await waitFor("introduction message", async () => {
      await failIfFixtureFailed(agentId);
      return (await introductionMessages(agentId)).length > 0;
    });
    const [introduction, ...extra] = await introductionMessages(agentId);
    expect(extra).toEqual([]);
    expect(introduction!.body).toBe(INTRODUCTION_BODY);
    const dueAfterSend = await dueAt(agentId);
    expect(dueAfterSend?.toISOString()).toBe(dueBefore!.toISOString());
    observations.introductionMessage = introduction;
    observations.introductionDueAtAfterSend = dueAfterSend?.toISOString() ?? null;
    const firstProcessTurns = (await turnsOf(agentId)).filter(({ pid }) => pid === firstPid);
    expect(firstProcessTurns.some(({ text }) => text === "Start.")).toBe(false);
    expect(
      firstProcessTurns.filter(({ text }) => text.startsWith(INTRODUCTION_MARKER)),
    ).toHaveLength(1);
    steps.push(
      "introduction message persisted in the creator↔Agent DM; introductionDueAt still set after the send",
    );

    // 4. A Restart's Start finds the landed introduction, settles it, and carries no prompt.
    const restarted = await restart(agentId);
    observations.restartView = restarted.view;
    const secondPid = restarted.pid;
    const secondProcessTurns = restarted.turns;
    expect(secondProcessTurns.some(({ text }) => text.startsWith(INTRODUCTION_MARKER))).toBe(false);
    expect(STARTERS).toContain(secondProcessTurns[0]!.text);
    await waitFor("introductionDueAt settled by the Restart's Start", async () => {
      return (await dueAt(agentId)) === null;
    });
    expect((await introductionMessages(agentId)).map(({ id }) => id)).toEqual([introduction!.id]);
    observations.introductionDueAtAfterRestart = (await dueAt(agentId))?.toISOString() ?? null;
    turnLogs[agentId] = await turnsOf(agentId);
    observations.turnsByProcess = {
      [`${firstPid}`]: firstProcessTurns.map(({ text }) => text.slice(0, 120)),
      [`${secondPid}`]: secondProcessTurns.map(({ text }) => text.slice(0, 120)),
    };
    steps.push(
      "Restart: new process opened with the ordinary starter; introductionDueAt cleared; DM still holds one introduction",
    );

    // 5. An Agent created without `introductionDueAt` (as system Agents are) is never introduced.
    const systemAgent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: "e2e-system-agent",
        displayName: "e2e-system-agent",
        description: "System Agent created without an introduction",
        visibility: "public",
        computerId: registration.computerId,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "e2e-model",
          modelProvider: "e2e-provider",
          reasoning: "balanced",
        },
      },
      select: { id: true, introductionDueAt: true },
    });
    systemAgentId = systemAgent.id;
    expect(systemAgent.introductionDueAt).toBeNull();
    observations.systemAgentStartView = await control.execute({
      userId: DEV_BROWSER_USER.id,
      workspaceId,
      agentId: systemAgent.id,
      requestId: crypto.randomUUID(),
      action: "start",
    });
    await waitFor("system Agent's first turn", async () => {
      await failIfFixtureFailed(systemAgent.id);
      return (await turnsOf(systemAgent.id)).length > 0;
    });
    const systemTurns = await turnsOf(systemAgent.id);
    turnLogs[systemAgent.id] = systemTurns;
    expect(systemTurns[0]!.text).toBe("Start.");
    expect(systemTurns.some(({ text }) => text.startsWith(INTRODUCTION_MARKER))).toBe(false);
    expect(await introductionMessages(systemAgent.id)).toEqual([]);
    observations.systemAgentTurns = systemTurns.map(({ text }) => text.slice(0, 120));
    steps.push("Agent created without introductionDueAt started with `Start.` and sent nothing");

    // 6. An Agent whose introduction never landed is asked again by the next Start.
    const unlanded = await createAgent(
      "e2e-quiet-introducer",
      `Stays quiet on purpose ${SKIP_INTRODUCTION_MARKER}`,
    );
    const unlandedId = unlanded.agent.id;
    unlandedAgentId = unlandedId;
    expect(unlanded.startPublished).toBe(true);
    const unlandedDue = await dueAt(unlandedId);
    expect(unlandedDue).toBeInstanceOf(Date);
    await waitFor("unlanded Agent's first turn", async () => {
      await failIfFixtureFailed(unlandedId);
      return (await turnsOf(unlandedId)).length > 0;
    });
    const unlandedFirst = await turnsOf(unlandedId);
    expect(unlandedFirst[0]!.text.startsWith(INTRODUCTION_MARKER)).toBe(true);
    const unlandedRestart = await restart(unlandedId);
    expect(unlandedRestart.turns[0]!.text.startsWith(INTRODUCTION_MARKER)).toBe(true);
    expect((await dueAt(unlandedId))?.toISOString()).toBe(unlandedDue!.toISOString());
    expect(await introductionMessages(unlandedId)).toEqual([]);
    turnLogs[unlandedId] = await turnsOf(unlandedId);
    observations.unlandedAgent = {
      agentId: unlandedId,
      introductionDueAt: unlandedDue!.toISOString(),
      introductionDueAtAfterRestart: (await dueAt(unlandedId))?.toISOString() ?? null,
      restartView: unlandedRestart.view,
      turns: turnLogs[unlandedId].map(({ pid, text }) => `${pid}: ${text.slice(0, 120)}`),
    };
    steps.push(
      "Agent whose introduction never landed got the introduction again as the restarted process's first turn",
    );

    outcome = "pass";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const agentId of [introducedAgentId, systemAgentId, unlandedAgentId])
      if (agentId && !turnLogs[agentId]) turnLogs[agentId] = await turnsOf(agentId);
    await runtime.stop();
    proxy.close();
    redis.close();
    // The data stays in place so the DM can be inspected in the browser afterwards.
    await db.$disconnect();
    await Bun.write(
      join(artifactDirectory, "report.json"),
      `${JSON.stringify(
        {
          feature: "agent-introduction",
          commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot })
            .stdout.toString()
            .trim(),
          environment: `local managed stack ${webUrl}`,
          recordedAt: new Date().toISOString(),
          steps,
          observations,
          outcome,
          ...(failure ? { failure } : {}),
        },
        null,
        2,
      )}\n`,
    );
    await Bun.write(
      join(artifactDirectory, "turns.json"),
      `${JSON.stringify(turnLogs, null, 2)}\n`,
    );
  }
}, 90_000);

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run scripts/e2e/run-agent-introduction.sh`);
  return value;
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}
