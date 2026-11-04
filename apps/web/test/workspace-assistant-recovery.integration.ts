import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import { startAssistantIfOwed } from "#src/server/agents/workspace-assistant-onboarding.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { createAgentIntroduction } from "#src/server/db/repositories/agent-introduction.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * While a member's setup wizard is pending, nothing they did not ask for may start their platform
 * assistant: not the Daemon coming ready (or a message's wake, which recovers through the same
 * `AgentControl.recover`), not `startAssistantIfOwed`. A started assistant could no longer be
 * re-bound by the wizard and would greet before it is done.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const created = { users: [] as string[], workspaces: [] as string[] };

async function pendingAssistant() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { username: `rec-${suffix}`, displayName: `rec-${suffix}` },
  });
  created.users.push(user.id);
  const workspace = await db.workspace.create({
    data: {
      name: "Recovery",
      slug: `rec-${suffix}`,
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  created.workspaces.push(workspace.id);
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `rec-${suffix}`,
      kind: "cloud",
      cloudSlot: "default",
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const assistants = new WorkspaceAssistants(db);
  const { agentId } = await assistants.ensure(workspace.id, user.id);
  await assistants.bindComputer(workspace.id, user.id, computer.id);
  const mark = (onboardingPendingSince: Date | null) =>
    db.workspaceMemberPreference.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: { workspaceId: workspace.id, userId: user.id, onboardingPendingSince },
      update: { onboardingPendingSince },
    });
  await mark(new Date());

  const published: string[] = [];
  const control = new AgentControl(
    new PrismaAgentControlStore(db),
    { publish: async (channel: string) => void published.push(channel) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
    undefined,
    undefined,
    undefined,
    undefined,
    createAgentIntroduction(db),
  );
  const ready = () =>
    new WorkspaceAgentRecovery(
      new PrismaAgentRepository(db),
      new PrismaDirectConversationRepository(db),
      { publish: async () => {} },
      { run: async (_id, work) => work() },
      { resendPending: async () => {} },
      undefined,
      control,
      new PrismaAgentControlStore(db),
    ).recoverWorkspace(workspace.id, computer.id, []);
  const controlState = async () =>
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).controlState;
  return { user, workspace, computer, agentId, mark, published, ready, controlState, assistants };
}

test("a Daemon coming ready leaves a pending member's assistant unstarted, so the wizard can still bind it", async () => {
  const w = await pendingAssistant();
  await w.ready();
  expect(w.published).toEqual([]);
  expect(await w.controlState()).toBeNull();
  await w.assistants.configure(
    w.workspace.id,
    w.user.id,
    {
      computerId: w.computer.id,
      runtimeConfig: {
        runtime: "claude-code",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
    async () => true,
  );
  const agent = await db.agent.findUniqueOrThrow({ where: { id: w.agentId } });
  expect(agent.runtimeConfig).toMatchObject({ runtime: "claude-code" });
});

test("startAssistantIfOwed publishes nothing while the wizard is pending, and starts once it is done", async () => {
  const w = await pendingAssistant();
  const starts: string[] = [];
  const publish = async (agent: { id: string }) => void starts.push(agent.id);
  await startAssistantIfOwed(db, { agentId: w.agentId }, publish);
  expect(starts).toEqual([]);
  await w.mark(null);
  await startAssistantIfOwed(db, { agentId: w.agentId }, publish);
  expect(starts).toEqual([w.agentId]);
});

test("once the wizard is done, the Daemon coming ready starts the assistant", async () => {
  const w = await pendingAssistant();
  await w.mark(null);
  await w.ready();
  expect(w.published).toHaveLength(1);
  expect(await w.controlState()).not.toBeNull();
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } }).catch(() => {});
  await db.computer.deleteMany({ where: { ownerId: { in: created.users } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await db.$disconnect();
});
