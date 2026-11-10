import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("channel unread: list counts other-authored top-level messages past the cursor, markRead advances monotonically, threads never count, join/addMembers seed the cursor", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `alice-${suffix}`, username: `alice-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `bob-${suffix}`, username: `bob-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Unread",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const engineering = await channels.create(workspace.id, alice.id, "unread-eng");

    // Joining seeds the cursor at the channel's current end: no backlog badge.
    await channels.join(workspace.id, alice.id, engineering.id);
    await channels.join(workspace.id, bob.id, engineering.id);
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: engineering.id,
        body,
        idempotencyKey: crypto.randomUUID(),
        ...(threadRootId ? { threadRootId } : {}),
      });

    const root = await send(alice.id, "root from alice");
    // bob's view: alice's top-level message is unread; alice's own never is.
    let list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);
    list = await channels.list(workspace.id, alice.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A thread reply never adds channel unread for bob.
    await send(alice.id, "thread reply", root.id);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A second top-level message bumps the count to 2.
    await send(alice.id, "second top-level");
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(2);

    // markRead clears it; a stale boundary cannot move the cursor backwards.
    await channels.markRead(workspace.id, bob.id, engineering.id, 10_000);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);
    await send(alice.id, "third after read");
    await channels.markRead(workspace.id, bob.id, engineering.id, 1);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A non-member has no unread badge even though history is readable.
    const carol = await db.user.create({
      data: { displayName: `carol-${suffix}`, username: `carol-${suffix}` },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: carol.id },
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.joined).toBe(false);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A newly added member starts already-read: addMembers seeds the cursor at the end.
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // Re-adding an already-active member is a no-op: it must not reset a cursor they had
    // advanced, or an admin re-running `channel add-member` would re-badge read history.
    await channels.markRead(workspace.id, carol.id, engineering.id, 10_000);
    await send(alice.id, "unread for carol");
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
