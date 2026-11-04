import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";

/**
 * Re-binding a member's assistant to another of their Computers and runtimes, which is allowed
 * only while the assistant has never run: no migration, nothing started.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const created = { users: [] as string[], workspaces: [] as string[] };

async function member(label: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { username: `cfg-${label}-${suffix}`, displayName: `cfg-${suffix}` },
  });
  created.users.push(user.id);
  const workspace = await db.workspace.create({
    data: {
      name: "Configure",
      slug: `cfg-${label}-${suffix}`,
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  created.workspaces.push(workspace.id);
  const computer = (ownerId: string, kind: "local" | "cloud" = "local") =>
    db.computer.create({
      data: {
        ownerId,
        machineId: `cfg-${crypto.randomUUID()}`,
        kind,
        ...(kind === "cloud" ? { cloudSlot: "default" } : {}),
        workspaces: { create: { workspaceId: workspace.id } },
      },
    });
  const { agentId } = await new WorkspaceAssistants(db).ensure(workspace.id, user.id);
  return { user, workspaceId: workspace.id, agentId, computer };
}

const runtime = (provider: "pi" | "claude-code" | "codex", model = "") => ({
  runtime: provider,
  provider: { kind: "default" as const },
  model,
  modelProvider: "",
  reasoning: "",
});

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (isAppError(error)) return error.errorId ?? error.code;
    throw error;
  }
  return undefined;
}

const yes = async () => true;

test("a never-run assistant is bound to the chosen computer and runtime, and can be moved again", async () => {
  const { user, workspaceId, agentId, computer } = await member("bind");
  const assistants = new WorkspaceAssistants(db);
  const local = await computer(user.id);
  await assistants.configure(
    workspaceId,
    user.id,
    { computerId: local.id, runtimeConfig: runtime("claude-code", "sonnet") },
    yes,
  );
  const bound = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(bound.computerId).toBe(local.id);
  expect(bound.runtimeConfig).toMatchObject({ runtime: "claude-code", model: "sonnet" });

  const cloud = await computer(user.id, "cloud");
  await assistants.configure(
    workspaceId,
    user.id,
    { computerId: cloud.id, runtimeConfig: runtime("pi") },
    yes,
  );
  const moved = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(moved.computerId).toBe(cloud.id);
  expect(moved.runtimeConfig).toMatchObject({ runtime: "pi" });
});

test("the Agent's encrypted environment survives a re-bind", async () => {
  const { user, workspaceId, agentId, computer } = await member("env");
  const local = await computer(user.id);
  const environment = { keyId: "k1", ciphertext: "c", nonce: "n" };
  await db.agent.update({
    where: { id: agentId },
    data: { runtimeConfig: { ...runtime("pi"), environment } },
  });
  await new WorkspaceAssistants(db).configure(
    workspaceId,
    user.id,
    { computerId: local.id, runtimeConfig: runtime("codex") },
    yes,
  );
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(agent.runtimeConfig).toMatchObject({ runtime: "codex", environment });
});

test("asking for what is already configured neither asks canRun nor writes", async () => {
  const { user, workspaceId, agentId, computer } = await member("same");
  const cloud = await computer(user.id, "cloud");
  await db.agent.update({ where: { id: agentId }, data: { computerId: cloud.id } });
  await new WorkspaceAssistants(db).configure(
    workspaceId,
    user.id,
    { computerId: cloud.id, runtimeConfig: runtime("pi") },
    async () => {
      throw new Error("canRun must not be asked");
    },
  );
});

test("a runtime the computer cannot run, another person's computer, and a started assistant are refused", async () => {
  const { user, workspaceId, agentId, computer } = await member("refuse");
  const assistants = new WorkspaceAssistants(db);
  const mine = await computer(user.id);
  const stranger = await member("stranger");
  const theirs = await stranger.computer(stranger.user.id);
  const input = { computerId: mine.id, runtimeConfig: runtime("codex") };
  expect(await refusal(assistants.configure(workspaceId, user.id, input, async () => false))).toBe(
    "agent-runtime-unavailable",
  );
  expect(
    await refusal(
      assistants.configure(workspaceId, user.id, { ...input, computerId: theirs.id }, yes),
    ),
  ).toBe("ACCESS_DENIED");
  await db.agent.update({
    where: { id: agentId },
    data: { controlState: { phase: "completed" } },
  });
  expect(await refusal(assistants.configure(workspaceId, user.id, input, yes))).toBe(
    "workspace-assistant-already-started",
  );
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(agent.computerId).not.toBe(mine.id);
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } }).catch(() => {});
  await db.computer.deleteMany({ where: { ownerId: { in: created.users } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await db.$disconnect();
});
