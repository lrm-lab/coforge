import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

export const connection = () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
};

export async function workspaceWithAgent(db: PrismaClient, suffix: string) {
  const owner = await db.user.create({
    data: { username: `inb-${suffix}`, displayName: "Owner" },
  });
  const workspace = await db.workspace.create({
    data: { slug: `inb-${suffix}`, name: "Inbox" },
  });
  await db.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: "owner" },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `inb-${suffix.slice(0, 8)}`,
      displayName: "Inbox",
      runtimeConfig: {},
    },
  });
  return { owner, workspace, agent };
}
