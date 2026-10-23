import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { SetupChecklist } from "#src/server/onboarding/setup-checklist.server";
import type { GitHubSetupStatus } from "#src/server/onboarding/setup-checklist.server";

const connectionString = Bun.env.ONBOARDING_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("ONBOARDING_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();

let github: GitHubSetupStatus = "disconnected";
const checklist = new SetupChecklist(db, { githubStatus: async () => github });

let workspaceId: string;
let ownerId: string;
let memberId: string;

async function steps(userId: string) {
  const { steps } = await checklist.read(workspaceId, userId);
  return Object.fromEntries(steps.map((step) => [step.id, step.done]));
}

async function agentFor(userId: string, extra: Record<string, unknown> = {}) {
  return db.agent.create({
    data: {
      workspaceId,
      ownerId: userId,
      name: `agent-${crypto.randomUUID()}`,
      displayName: "Agent",
      runtimeConfig: {},
      ...extra,
    },
  });
}

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `owner-${suffix}`, displayName: "Owner" },
  });
  const member = await db.user.create({
    data: { username: `member-${suffix}`, displayName: "Member" },
  });
  ownerId = owner.id;
  memberId = member.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Setup checklist",
      slug: `setup-${suffix}`,
      members: { create: { userId: ownerId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("a new Workspace owner has nothing done and sees every step in order", async () => {
  const { steps } = await checklist.read(workspaceId, ownerId);
  expect(steps).toEqual([
    { id: "assistant", done: false },
    { id: "github", done: false },
    { id: "agent", done: false },
    { id: "task", done: false },
    { id: "computer", done: false },
    { id: "invite", done: false },
  ]);
});

test("saying hi to the assistant is done once the viewer has sent a message in their own DM", async () => {
  const session = await new WorkspaceAssistants(db).ensure(workspaceId, ownerId);
  expect((await steps(ownerId)).assistant).toBe(false);
  const { assistantConversationId } = await checklist.read(workspaceId, ownerId);
  expect(assistantConversationId).toBe(session.conversationId);
  const viewer = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: session.conversationId, userId: ownerId },
  });
  const agentSide = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: session.conversationId, agentId: session.agentId },
  });
  // The assistant's own introduction is not the viewer saying hi.
  await db.message.create({
    data: {
      conversationId: session.conversationId,
      workspaceId,
      senderMemberId: agentSide.id,
      body: "Hello",
      sequence: 1,
    },
  });
  expect((await steps(ownerId)).assistant).toBe(false);
  await db.message.create({
    data: {
      conversationId: session.conversationId,
      workspaceId,
      senderMemberId: viewer.id,
      body: "hi",
      sequence: 2,
    },
  });
  expect((await steps(ownerId)).assistant).toBe(true);
  expect(
    (await db.conversation.findUniqueOrThrow({ where: { id: session.conversationId } })).directKey,
  ).toBe(agentDirectKey(ownerId, session.agentId));
});

test("GitHub is done only when connected, and is left out when the deployment has none", async () => {
  for (const status of ["disconnected", "pending_installation", "reauthorize"] as const) {
    github = status;
    expect((await steps(ownerId)).github).toBe(false);
  }
  github = "connected";
  expect((await steps(ownerId)).github).toBe(true);
  github = "unconfigured";
  const { steps: listed } = await checklist.read(workspaceId, ownerId);
  expect(listed.map((step) => step.id)).toEqual([
    "assistant",
    "agent",
    "task",
    "computer",
    "invite",
  ]);
});

test("a GitHub lookup that fails leaves the step undone instead of failing the checklist", async () => {
  const failing = new SetupChecklist(db, {
    githubStatus: async () => {
      throw new Error("unavailable");
    },
  });
  const { steps: listed } = await failing.read(workspaceId, ownerId);
  expect(listed.find((step) => step.id === "github")).toEqual({ id: "github", done: false });
});

test("only an ordinary Agent the viewer owns in this Workspace counts as their first Agent", async () => {
  await agentFor(ownerId, { systemKind: "workspace-assistant" });
  await agentFor(memberId);
  await agentFor(ownerId, { deletedAt: new Date() });
  expect((await steps(ownerId)).agent).toBe(false);
  const other = await db.workspace.create({
    data: {
      name: "Other",
      slug: `other-${suffix}`,
      members: { create: { userId: ownerId, role: "owner" } },
    },
  });
  await db.agent.create({
    data: {
      workspaceId: other.id,
      ownerId,
      name: `agent-${crypto.randomUUID()}`,
      displayName: "Elsewhere",
      runtimeConfig: {},
    },
  });
  expect((await steps(ownerId)).agent).toBe(false);
  await db.workspace.delete({ where: { id: other.id } });
  await agentFor(ownerId);
  expect((await steps(ownerId)).agent).toBe(true);
});

test("a Task counts when the viewer created it and an Agent owns it", async () => {
  expect((await steps(ownerId)).task).toBe(false);
  const agent = await agentFor(ownerId);
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `tasks-${suffix}`,
      members: { create: [{ userId: ownerId }, { agentId: agent.id }, { userId: memberId }] },
    },
    include: { members: true },
  });
  const human = conversation.members.find((member) => member.userId === ownerId)!;
  const other = conversation.members.find((member) => member.userId === memberId)!;
  const bot = conversation.members.find((member) => member.agentId === agent.id)!;
  const task = async (number: number, creator: string, owner: string | null) => {
    const message = await db.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId,
        senderMemberId: creator,
        body: `task ${number}`,
        sequence: number,
      },
    });
    await db.task.create({
      data: {
        messageId: message.id,
        conversationId: conversation.id,
        workspaceId,
        number,
        title: `task ${number}`,
        creatorMemberId: creator,
        ownerMemberId: owner,
      },
    });
  };
  // Unowned, owned by a person, or created by someone else: none is the viewer assigning an Agent.
  await task(1, human.id, null);
  await task(2, human.id, other.id);
  await task(3, other.id, bot.id);
  expect((await steps(ownerId)).task).toBe(false);
  await task(4, human.id, bot.id);
  expect((await steps(ownerId)).task).toBe(true);
});

test("a local Computer the viewer owns is done; cloud, deleted and others' do not count", async () => {
  const computer = (ownerUserId: string, data: Record<string, unknown>) =>
    db.computer.create({
      data: { ownerId: ownerUserId, machineId: `m-${crypto.randomUUID()}`, ...data },
    });
  await computer(ownerId, { kind: "cloud", cloudSlot: "default" });
  await computer(ownerId, { deletedAt: new Date() });
  await computer(memberId, {});
  expect((await steps(ownerId)).computer).toBe(false);
  await computer(ownerId, {});
  expect((await steps(ownerId)).computer).toBe(true);
});

test("inviting is offered to roles that can invite, and done with a second person", async () => {
  github = "disconnected";
  expect((await steps(ownerId)).invite).toBe(false);
  await db.workspaceMembership.create({ data: { workspaceId, userId: memberId, role: "member" } });
  expect((await steps(ownerId)).invite).toBe(true);
  // A plain member cannot invite, so the step (and Agent creation) is not theirs to do.
  const { steps: plain } = await checklist.read(workspaceId, memberId);
  expect(plain.map((step) => step.id)).toEqual(["assistant", "github", "task", "computer"]);
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId: memberId } },
    data: { role: "admin" },
  });
  expect((await steps(memberId)).invite).toBe(true);
});

test("a viewer who is not in the Workspace is refused", async () => {
  const stranger = await db.user.create({
    data: { username: `stranger-${suffix}`, displayName: "Stranger" },
  });
  await expect(checklist.read(workspaceId, stranger.id)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

test("a dismissed checklist stays closed for that member in that Workspace only, whenever it is read", async () => {
  const closer = await db.user.create({
    data: { username: `closer-${suffix}`, displayName: "Closer" },
  });
  const bystander = await db.user.create({
    data: { username: `bystander-${suffix}`, displayName: "Bystander" },
  });
  const second = await db.workspace.create({
    data: {
      name: "Second",
      slug: `second-${suffix}`,
      members: { create: [{ userId: closer.id }, { userId: bystander.id }] },
    },
  });
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId, userId: closer.id },
      { workspaceId, userId: bystander.id },
    ],
  });
  try {
    expect((await checklist.read(workspaceId, closer.id)).dismissed).toBe(false);
    await checklist.dismiss(workspaceId, closer.id);
    expect(await checklist.read(workspaceId, closer.id)).toMatchObject({
      dismissed: true,
      steps: [],
    });
    expect((await checklist.read(workspaceId, bystander.id)).dismissed).toBe(false);
    const elsewhere = await checklist.read(second.id, closer.id);
    expect(elsewhere.dismissed).toBe(false);
    expect(elsewhere.steps.length).toBeGreaterThan(0);

    // Closing it again keeps the first time.
    const stored = () =>
      db.workspaceMemberPreference.findUniqueOrThrow({
        where: { workspaceId_userId: { workspaceId, userId: closer.id } },
      });
    const first = (await stored()).setupChecklistDismissedAt;
    expect(first).not.toBeNull();
    await Bun.sleep(5);
    await checklist.dismiss(workspaceId, closer.id);
    expect((await stored()).setupChecklistDismissedAt).toEqual(first);
  } finally {
    await db.workspace.delete({ where: { id: second.id } });
  }
});

test("dismissing keeps the member's other preferences", async () => {
  const user = await db.user.create({ data: { username: `keeper-${suffix}`, displayName: "K" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: user.id } });
  await db.workspaceMemberPreference.create({
    data: { workspaceId, userId: user.id, chatSectionOrder: ["pinned", "channels"] },
  });
  await checklist.dismiss(workspaceId, user.id);
  const row = await db.workspaceMemberPreference.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  expect(row.chatSectionOrder).toEqual(["pinned", "channels"]);
  expect(row.setupChecklistDismissedAt).not.toBeNull();
});

test("a viewer who is not in the Workspace cannot dismiss it", async () => {
  const stranger = await db.user.create({
    data: { username: `outsider-${suffix}`, displayName: "Outsider" },
  });
  await expect(checklist.dismiss(workspaceId, stranger.id)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});
