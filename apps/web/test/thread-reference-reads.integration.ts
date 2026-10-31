import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import {
  MAX_THREAD_REFERENCES,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("a body's thread references are read in one query per channel, and only the first MAX_THREAD_REFERENCES of them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Thread reference reads",
      members: { create: { userId: user.id } },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const random = await channels.create(workspace.id, user.id, "random");
    let sequence = 1_000_000;
    const createRoot = async (conversationId: string, id = crypto.randomUUID()) =>
      (
        await db.message.create({
          data: {
            id,
            conversationId,
            workspaceId: workspace.id,
            body: "root",
            sequence: sequence++,
          },
        })
      ).id;
    // Six roots in #product, two more sharing a six-hex prefix, one root in #random.
    const productRoots = await Promise.all(Array.from({ length: 6 }, () => createRoot(product.id)));
    const prefix = crypto.randomUUID().slice(0, 6);
    await createRoot(product.id, `${prefix}00-0000-4000-8000-000000000000`);
    await createRoot(product.id, `${prefix}ff-0000-4000-8000-000000000001`);
    const randomRoot = await createRoot(random.id);
    const token = (channel: { id: string }, name: string, root: string) =>
      `<@thread:${channel.id}:${root}:${name}>`;

    /** `storeMessageBody` in a transaction whose message reads are counted. */
    const store = (body: string) =>
      db.$transaction(async (tx) => {
        const reads: unknown[] = [];
        const counted = {
          task: tx.task,
          conversation: tx.conversation,
          message: {
            findMany: (args: Parameters<typeof tx.message.findMany>[0]) => {
              reads.push(args);
              return tx.message.findMany(args);
            },
          },
        } as unknown as Parameters<typeof storeMessageBody>[0];
        const stored = await storeMessageBody(
          counted,
          { workspaceId: workspace.id, conversationId: general.id, reader: { userId: user.id } },
          body,
          { targets: [] },
        );
        return { body: stored.body, reads: reads.length };
      });

    // References into two channels take one read each, however many there are; a prefix two
    // messages share, read in the same batch, still names nothing.
    const [first] = productRoots;
    const mixed = await store(
      [
        `#product:${first!.slice(0, 8)}`,
        `#product:${prefix}`,
        `#product:${first!.slice(0, 6)}`,
        `#random:${randomRoot.slice(0, 7)}`,
        `#random:${randomRoot}`,
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.body).toBe(
      [
        token(product, "product", first!),
        `#product:${prefix}`,
        token(product, "product", first!),
        token(random, "random", randomRoot),
        token(random, "random", randomRoot),
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.reads).toBe(2);

    // Twenty-four distinct references: the first MAX_THREAD_REFERENCES resolve, the rest stay text.
    const spellings = productRoots.flatMap((root) => [
      `#product:${root.slice(0, 6)}`,
      `#product:${root.slice(0, 7)}`,
      `#product:${root.slice(0, 8)}`,
      `#product:${root}`,
    ]);
    expect(spellings.length).toBeGreaterThan(MAX_THREAD_REFERENCES);
    const capped = await store(spellings.join(" "));
    expect(capped.body).toBe(
      spellings
        .map((written, index) =>
          index < MAX_THREAD_REFERENCES
            ? token(product, "product", productRoots[Math.floor(index / 4)]!)
            : written,
        )
        .join(" "),
    );
    expect(capped.reads).toBe(1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});
