import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

// How #general membership is made: at write points and by the backfill, never by a read
// (moved from `public-channel.integration.ts`).

test("reads never enroll: general membership comes from write points and the backfill migration", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ea${suffix}`, username: `ea${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `eb${suffix}`, username: `eb${suffix}` },
  });
  // A pre-backfill Workspace: humans and an Agent exist, general does not.
  const workspace = await db.workspace.create({
    data: {
      slug: `enroll-${suffix}`,
      name: "Legacy workspace",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "legacy-helper",
        displayName: "Legacy Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db);
    expect(await channels.list(workspace.id, alice.id)).toEqual([]);

    const migration = (
      await Bun.file(
        new URL(
          "../prisma/migrations/20260915120000_backfill_general_channel/migration.sql",
          import.meta.url,
        ),
      ).text()
    )
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((part) => part.trim());
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      include: { members: { orderBy: { userId: "asc" } } },
    });
    expect(general.members.map((m) => m.userId ?? m.agentId).sort()).toEqual(
      [alice.id, bob.id, agent.id].sort(),
    );
    expect(await channels.list(workspace.id, bob.id)).toEqual([
      {
        id: general.id,
        name: "general",
        joined: true,
        archived: false,
        muted: false,
        unreadCount: 0,
        mentioned: false,
        lastMessage: null,
        members: expect.any(Array),
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      },
    ]);

    // Re-running the backfill is a no-op.
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);

    // A membership row written outside the write points is not repaired by reads.
    const carol = await db.user.create({
      data: { displayName: `ec${suffix}`, username: `ec${suffix}` },
    });
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: carol.id },
      });
      expect(await channels.list(workspace.id, carol.id)).toEqual([
        {
          id: general.id,
          name: "general",
          joined: false,
          archived: false,
          muted: false,
          unreadCount: 0,
          mentioned: false,
          lastMessage: null,
          members: expect.any(Array),
          hidden: false,
          pinned: false,
          pinSortOrder: null,
        },
      ]);
      await channels.open(workspace.id, carol.id, general.id);
      expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);
    } finally {
      await db.user.delete({ where: { id: carol.id } });
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
