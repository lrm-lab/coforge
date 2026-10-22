import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";

/**
 * Who reads an Agent's Activity, against real PostgreSQL: its creator and a Workspace owner or
 * admin, as the profile panel's Activity tab and the Agent card show it. A plain member reads only
 * their own Agents', and nobody but its member reads a platform assistant's.
 */

const connectionString = Bun.env.AGENT_ACTIVITY_TEST_DATABASE_URL;
if (!connectionString) throw new Error("AGENT_ACTIVITY_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = new AgentActivityRepository(db);
const suffix = crypto.randomUUID().slice(0, 8);
const usernames = ["owner", "admin", "creator", "member"].map((name) => `aa-${name}-${suffix}`);
let users: Record<"owner" | "admin" | "creator" | "member", string>;
let agents: Record<"creators" | "members" | "assistant", string>;
let workspaceId: string;

beforeAll(async () => {
  const [owner, admin, creator, member] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { username, displayName: username } })),
  );
  users = { owner: owner!.id, admin: admin!.id, creator: creator!.id, member: member!.id };
  const workspace = await db.workspace.create({
    data: {
      slug: `aa-${suffix}`,
      name: "Activity access",
      members: {
        create: [
          { userId: users.owner, role: "owner" },
          { userId: users.admin, role: "admin" },
          { userId: users.creator, role: "member" },
          { userId: users.member, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const computer = await db.computer.create({
    data: { ownerId: users.creator, machineId: `aa-${suffix}` },
  });
  const agent = (name: string, ownerId: string, extra: object = {}) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId,
        computerId: computer.id,
        name: `${name}-${suffix}`,
        displayName: name,
        runtimeConfig: {},
        ...extra,
      },
    });
  const [creators, members, assistant] = await Promise.all([
    agent("creators", users.creator),
    agent("members", users.member),
    agent("assistant", users.creator, {
      visibility: "private",
      systemKind: WORKSPACE_ASSISTANT_KIND,
    }),
  ]);
  agents = { creators: creators.id, members: members.id, assistant: assistant.id };
  await db.agentActivity.createMany({
    data: Object.values(agents).map((agentId) => ({
      agentId,
      workspaceId,
      computerId: computer.id,
      launchId: "launch-1",
      clientSeq: 1,
      detailKind: "idle",
      level: "info",
      detail: "",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      entries: [],
    })),
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug: `aa-${suffix}` } });
  await db.computer.deleteMany({ where: { machineId: `aa-${suffix}` } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("the Agent card's recent Activity holds only the Agents the viewer manages", async () => {
  const listed = async (userId: string) =>
    (await repository.listForManager(workspaceId, userId)).map(({ id }) => id).sort();
  expect(await listed(users.member)).toEqual([agents.members]);
  expect(await listed(users.creator)).toEqual([agents.creators, agents.assistant].sort());
  for (const userId of [users.owner, users.admin])
    expect(await listed(userId)).toEqual([agents.creators, agents.members].sort());
});

test("an Agent's Activity feed is for its creator and a Workspace owner or admin", async () => {
  const feed = (userId: string, agentId: string) =>
    repository.feedForManager(workspaceId, userId, agentId);
  for (const userId of [users.creator, users.owner, users.admin])
    expect(await feed(userId, agents.creators)).toHaveLength(1);
  expect(await feed(users.member, agents.creators)).toBeUndefined();
  for (const userId of [users.owner, users.admin])
    expect(await feed(userId, agents.assistant)).toBeUndefined();
});
