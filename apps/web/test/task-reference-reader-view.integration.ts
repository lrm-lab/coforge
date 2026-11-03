import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { dmTaskReferenceToken, readableBody } from "@lrm/coforge-sdk/internal";
import { dmTaskReferenceView } from "#src/server/conversations/task-reference-view.server";

test("a DM task reads from each reader's seat: sender, peer, and an outsider", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { username: `owner-${suffix}`, displayName: "Owner" },
  });
  const workspace = await db.workspace.create({
    data: { slug: `dmview-${suffix}`, name: "DM view", members: { create: { userId: owner.id } } },
  });
  try {
    const agents = await Promise.all(
      ["a", "b", "c"].map((label) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `${label}-${suffix}`,
            displayName: label.toUpperCase(),
            runtimeConfig: {},
          },
        }),
      ),
    );
    const [a, b, c] = agents;
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `general`,
        members: { create: agents.map((agent) => ({ agentId: agent.id })) },
      },
    });
    const dm = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: `agent:${a!.id}|agent:${b!.id}`,
        members: { create: [{ agentId: a!.id }, { agentId: b!.id }] },
      },
    });
    const body = dmTaskReferenceToken(dm.id, b!.name, 9);
    const read = async (agentId: string, conversationId: string) => {
      const view = await dmTaskReferenceView(db, workspace.id, agentId, conversationId, body);
      return readableBody(body, { mention: () => undefined, ...(view ? { task: view } : {}) });
    };
    // In another conversation: each member reads the DM's other party; an outsider the token.
    expect(await read(a!.id, channel.id)).toBe(`dm:@${b!.name}:#9`);
    expect(await read(b!.id, channel.id)).toBe(`dm:@${a!.name}:#9`);
    expect(await read(c!.id, channel.id)).toBe(`dm:@${b!.name}:#9`);
    // Inside the DM itself the task is the local one.
    expect(await read(b!.id, dm.id)).toBe("#9");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("a DM's other party carries a kind suffix when a person and an Agent share the handle", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const handle = `shared-${suffix}`;
  const owner = await db.user.create({
    data: { username: `owner-${suffix}`, displayName: "Owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `dmamb-${suffix}`,
      name: "DM ambiguity",
      members: { create: { userId: owner.id } },
    },
  });
  const twinUser = await db.user.create({ data: { username: handle, displayName: "Twin" } });
  try {
    const reader = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `reader-${suffix}`,
        displayName: "Reader",
        runtimeConfig: {},
      },
    });
    const twinAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: handle,
        displayName: "Twin",
        runtimeConfig: {},
      },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: twinUser.id },
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "general" },
    });
    const dm = (peer: { agentId: string } | { userId: string }) =>
      db.conversation.create({
        data: {
          workspaceId: workspace.id,
          directKey: `agent:${reader.id}|${"agentId" in peer ? `agent:${peer.agentId}` : `user:${peer.userId}`}`,
          members: {
            create: [
              { agentId: reader.id },
              "agentId" in peer ? { agentId: peer.agentId } : { userId: peer.userId },
            ],
          },
        },
      });
    const agentDm = await dm({ agentId: twinAgent.id });
    const userDm = await dm({ userId: twinUser.id });
    const read = async (conversationId: string, dmId: string) => {
      const body = dmTaskReferenceToken(dmId, handle, 9);
      const view = await dmTaskReferenceView(db, workspace.id, reader.id, conversationId, body);
      return readableBody(body, { mention: () => undefined, ...(view ? { task: view } : {}) });
    };
    expect(await read(channel.id, agentDm.id)).toBe(`dm:@${handle}~agent:#9`);
    expect(await read(channel.id, userDm.id)).toBe(`dm:@${handle}~human:#9`);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, twinUser.id] } } });
    await db.$disconnect();
  }
});
