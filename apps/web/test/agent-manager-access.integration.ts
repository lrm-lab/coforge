import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "#src/server/agents/agent-reminders.server";
import { findWorkspaceFilesAssignment } from "#src/server/agents/agent-workspace-files.server";

/**
 * Who reads an Agent's profile-panel tabs beyond Profile, against real PostgreSQL: its workspace
 * files and its reminders are for the Agent's creator and a Workspace owner or admin, never a plain
 * member who did not create it.
 */

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const usernames = ["owner", "admin", "creator", "member"].map((name) => `wf-${name}-${suffix}`);
let users: { owner: string; admin: string; creator: string; member: string };
let workspaceId: string;
let computerId: string;
let agentId: string;

beforeAll(async () => {
  const [owner, admin, creator, member] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { username, displayName: username } })),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `wf-${suffix}`,
      name: "Workspace files",
      members: {
        create: [
          { userId: owner!.id, role: "owner" },
          { userId: admin!.id, role: "admin" },
          { userId: creator!.id, role: "member" },
          { userId: member!.id, role: "member" },
        ],
      },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: creator!.id, machineId: `wf-${suffix}`, name: "creator-mac" },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: creator!.id,
      computerId: computer.id,
      name: `wf-agent-${suffix}`,
      displayName: "Files",
      runtimeConfig: {},
    },
  });
  users = { owner: owner!.id, admin: admin!.id, creator: creator!.id, member: member!.id };
  workspaceId = workspace.id;
  computerId = computer.id;
  agentId = agent.id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug: `wf-${suffix}` } });
  await db.computer.deleteMany({ where: { machineId: `wf-${suffix}` } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("the Agent's creator and a Workspace owner or admin browse its workspace files", async () => {
  const assignmentFor = (userId: string) =>
    findWorkspaceFilesAssignment(db, { userId, workspaceId }, agentId);
  for (const viewer of [users.creator, users.owner, users.admin])
    expect(await assignmentFor(viewer)).toMatchObject({ computerId });
  expect(await assignmentFor(users.member)).toBeUndefined();
});

test("the Agent's creator and a Workspace owner or admin read its reminders", async () => {
  const reminder = await db.reminder.create({
    data: {
      workspaceId,
      ownerAgentId: agentId,
      computerId,
      title: "Check the build",
      target: "self",
      messageId: crypto.randomUUID(),
      fireAt: new Date("2026-12-01T09:00:00Z"),
    },
  });
  const query = new AgentRemindersQuery(prismaAgentReminderReadStore(db));
  const listFor = (userId: string) => query.list({ userId, workspaceId }, { agentId });
  for (const viewer of [users.creator, users.owner, users.admin])
    expect(await listFor(viewer)).toMatchObject({
      status: "ready",
      reminders: [{ id: reminder.id, title: "Check the build" }],
    });
  expect(await listFor(users.member)).toEqual({ status: "unauthorized" });
});
