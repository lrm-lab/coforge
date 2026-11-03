import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("channel unread: marking unread counts from the newest message someone else sent, and a read past it clears it", async () => {
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
      name: "Unread marker",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  try {
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const channel = await channels.create(workspace.id, alice.id, "unread-marker");
    await channels.join(workspace.id, alice.id, channel.id);
    await channels.join(workspace.id, bob.id, channel.id);
    const send = (userId: string, body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: channel.id,
        body,
        idempotencyKey: crypto.randomUUID(),
      });
    const unreadFor = async (userId: string) =>
      (await channels.list(workspace.id, userId)).find((c) => c.id === channel.id)?.unreadCount;

    await send(alice.id, "one");
    await send(alice.id, "two");
    await channels.markRead(workspace.id, bob.id, channel.id, 10_000);
    expect(await unreadFor(bob.id)).toBe(0);

    // Marked unread: the newest message counts again although the cursor is past it.
    await channels.setUserUnread(workspace.id, bob.id, channel.id, true);
    expect(await unreadFor(bob.id)).toBe(1);
    // Newer messages add to it; the viewer's own message still never counts.
    await send(alice.id, "three");
    await send(bob.id, "bob's own");
    expect(await unreadFor(bob.id)).toBe(2);

    // Reading through the end clears the marker.
    await channels.markRead(workspace.id, bob.id, channel.id, 10_000);
    expect(await unreadFor(bob.id)).toBe(0);

    // Clearing the marker by hand leaves only what is past the cursor.
    await channels.setUserUnread(workspace.id, bob.id, channel.id, true);
    await channels.setUserUnread(workspace.id, bob.id, channel.id, false);
    expect(await unreadFor(bob.id)).toBe(0);

    // With the viewer's own message newest, marking reopens the newest message someone else sent.
    await send(bob.id, "bob again");
    expect(await channels.setUserUnread(workspace.id, bob.id, channel.id, true)).toEqual({
      unread: true,
    });
    expect(await unreadFor(bob.id)).toBe(1);

    // A channel where only the viewer has spoken has nothing to mark.
    const solo = await channels.create(workspace.id, bob.id, "unread-marker-solo");
    await channels.join(workspace.id, bob.id, solo.id);
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: solo.id,
      body: "only bob",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await channels.setUserUnread(workspace.id, bob.id, solo.id, true)).toEqual({
      unread: false,
    });
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    redis.close();
    await db.$disconnect();
  }
});
