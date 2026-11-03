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
