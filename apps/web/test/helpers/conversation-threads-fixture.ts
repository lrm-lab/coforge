/** The Workspace, people, Agent and channel the conversation-thread suites read. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

export async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({
    data: { displayName: `th-ada-${suffix}`, username: `th-ada-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `th-bob-${suffix}`, username: `th-bob-${suffix}` },
  });
  const cy = await db.user.create({
    data: { displayName: `th-cy-${suffix}`, username: `th-cy-${suffix}` },
  });
  const outsider = await db.user.create({
    data: { displayName: `th-out-${suffix}`, username: `th-out-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `th-${suffix}`,
      name: "Threads",
      members: {
        create: [
          { userId: ada.id, role: "owner" },
          { userId: bob.id, role: "member" },
          { userId: cy.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: ada.id,
      name: `nova-${suffix}`,
      displayName: "Nova",
      runtimeConfig: {},
    },
  });
  const channels = new PublicChannels(db);
  const team = await channels.create(workspace.id, ada.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  await db.conversationMember.create({
    data: { conversationId: team.id, workspaceId: workspace.id, agentId: agent.id },
  });
  const memberOf = (conversationId: string, who: { userId: string } | { agentId: string }) =>
    db.conversationMember.findFirstOrThrow({ where: { conversationId, ...who } });
  /** Stores a message the way a send does: top-level, or a reply when `threadRootId` is given. */
  const post = async (
    conversationId: string,
    sender: { userId: string } | { agentId: string } | "system",
    body: string,
    threadRootId?: string,
  ) => {
    const member = sender === "system" ? undefined : await memberOf(conversationId, sender);
    const latest = await db.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
    });
    return db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: member?.id ?? null,
        body,
        threadRootId,
        sequence: (latest?.sequence ?? 0) + 1,
      },
    });
  };
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, workspace, ada, bob, cy, outsider, agent, channels, team, memberOf, post, teardown };
}
