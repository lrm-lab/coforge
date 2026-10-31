import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

/**
 * A channel a person closed stays closed until someone else posts a top-level message after the
 * close. Skipped unless `CHANNEL_TEST_DATABASE_URL` and `CHANNEL_TEST_REDIS_URL` point at local
 * PostgreSQL and Redis.
 */
test("a closed channel stays closed until someone else posts a top-level message after the close", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ca${suffix.slice(0, 8)}`, username: `ca${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `cb${suffix.slice(0, 8)}`, username: `cb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Closed chats",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const ops = await channels.create(workspace.id, alice.id, "ops");
    await channels.join(workspace.id, bob.id, ops.id);
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: ops.id,
        body,
        idempotencyKey: crypto.randomUUID(),
        ...(threadRootId ? { threadRootId } : {}),
      });
    const listed = async () =>
      (await channels.list(workspace.id, alice.id)).find((channel) => channel.id === ops.id);

    // Unread from before the close does not hold the chat open.
    const root = await send(bob.id, "before the close");
    await channels.setUserHidden(workspace.id, alice.id, ops.id, true);
    expect(await listed()).toBeUndefined();
    // A closed channel stays in the names a body's channel references link by (and the composer's
    // `#` list offers): closing hides it from the list, not from the Workspace.
    expect(
      (await channels.names(workspace.id, alice.id)).find((channel) => channel.id === ops.id),
    ).toEqual({ id: ops.id, name: "ops", description: "", archived: false, visibility: "public" });

    // Alice's own message is not "someone else posting".
    await Bun.sleep(2); // createdAt and hiddenAt are millisecond timestamps
    await send(alice.id, "my own, after the close");
    expect(await listed()).toBeUndefined();

    // A thread reply belongs to its thread, not the channel list.
    await send(bob.id, "a reply, after the close", root.id);
    expect(await listed()).toBeUndefined();

    await send(bob.id, "after the close");
    expect(await listed()).toEqual(expect.objectContaining({ hidden: false, unreadCount: 2 }));
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
