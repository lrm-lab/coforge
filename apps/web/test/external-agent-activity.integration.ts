import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";

const connectionString = Bun.env.AGENT_ACTIVITY_TEST_DATABASE_URL;
if (!connectionString) throw new Error("AGENT_ACTIVITY_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const slugs: string[] = [];

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug: { in: slugs } } });
  await db.user.deleteMany({ where: { username: { in: slugs } } });
  await db.$disconnect();
});

test("an external Agent's activity row has no Computer, is read in its feed and is stored once", async () => {
  const slug = `ext-activity-${crypto.randomUUID().slice(0, 8)}`;
  slugs.push(slug);
  const owner = await db.user.create({ data: { displayName: slug, username: slug } });
  const workspace = await db.workspace.create({
    data: { slug, name: "External activity", members: { create: { userId: owner.id } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: "external-bot",
      displayName: "External bot",
      hosting: "external",
      runtimeConfig: {},
    },
  });
  const repository = new AgentActivityRepository(db);
  const row = {
    protocolMajor: 1,
    requestId: "external:e1",
    workspaceId: workspace.id,
    agentId: agent.id,
    detailKind: "tool_started",
    level: "info" as const,
    detail: "",
    observedAtMs: Date.now(),
    launchId: "external:e1",
    clientSeq: 1,
    entries: [{ kind: "tool_start" as const, toolName: "Bash" }],
    computerId: null,
  };
  await repository.recordMany([row]);
  await repository.recordMany([row]);
  const feed = await repository.list(workspace.id, agent.id, owner.id);
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({
    detailKind: "tool_started",
    launchId: "external:e1",
    activityKind: "working",
    entries: [{ kind: "tool_start", toolName: "Bash" }],
  });
  const cards = await repository.listForManager(workspace.id, owner.id);
  expect(cards.find((card) => card.id === agent.id)?.activity).toHaveLength(1);

  expect(
    (await db.agent.findUnique({ where: { id: agent.id } }))?.externalStatusReportedAt,
  ).toBeNull();
  await db.agent.updateMany({
    where: { id: agent.id, externalStatusReportedAt: null },
    data: { externalStatusReportedAt: new Date() },
  });
  expect(
    (await db.agent.findUnique({ where: { id: agent.id } }))?.externalStatusReportedAt,
  ).not.toBeNull();
});
