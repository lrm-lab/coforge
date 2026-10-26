import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
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
    { id: "github", done: false },
    { id: "agent", done: false },
    { id: "computer", done: false },
  ]);
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
  expect(listed.map((step) => step.id)).toEqual(["agent", "computer"]);
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

test("finishing the three remaining steps completes setup without assistant messages, tasks or invites", async () => {
  github = "connected";
  expect((await checklist.read(workspaceId, ownerId)).steps).toEqual([
    { id: "github", done: true },
    { id: "agent", done: true },
    { id: "computer", done: true },
  ]);
});

test("roles that cannot create Agents see only GitHub and Computer", async () => {
  github = "disconnected";
  await db.workspaceMembership.create({ data: { workspaceId, userId: memberId, role: "member" } });
  expect((await checklist.read(workspaceId, memberId)).steps.map((step) => step.id)).toEqual([
    "github",
    "computer",
  ]);
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId: memberId } },
    data: { role: "admin" },
  });
  expect((await checklist.read(workspaceId, memberId)).steps.map((step) => step.id)).toEqual([
    "github",
    "agent",
    "computer",
  ]);
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
