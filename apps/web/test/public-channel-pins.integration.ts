import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";
import { isAppError } from "#src/lib/app-error";

test("pins keep one order across the member's channels and DMs: a new pin goes last, a pin made again after unpinning goes last", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `pa${suffix.slice(0, 8)}`, username: `pa${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Pins", members: { create: [{ userId: alice.id }] } },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new DirectConversations(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    const { conversationId: helperDm } = await directs.open(workspace.id, alice.id, {
      agentId: helper.id,
    });

    /** The member's pins as one list, the way the sidebar's Pinned section reads them. */
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.list(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await directs.setPinned(workspace.id, alice.id, helperDm, true);
    await channels.setUserPinned(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Pinning what is already pinned keeps its place.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Unpinning and pinning again puts it after every other pin, never on a slot another pin holds.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, false);
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
    const orders = (await channels.list(workspace.id, alice.id))
      .filter((channel) => channel.pinned)
      .map((channel) => channel.pinSortOrder);
    expect(new Set(orders).size).toBe(orders.length);

    // Closing a pinned chat does not take it out of Pinned: the list keeps reporting it.
    await channels.setUserHidden(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: alice.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("arranging a member's pins sets their order in one step, pins what is new, unpins only what it names, and refuses conversations the member is not in", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ra${suffix.slice(0, 8)}`, username: `ra${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `rb${suffix.slice(0, 8)}`, username: `rb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Pin order",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new DirectConversations(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    const bobsOwn = await channels.create(workspace.id, bob.id, "bobs");
    const { conversationId: helperDm } = await directs.open(workspace.id, alice.id, {
      agentId: helper.id,
    });
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.list(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    // A new pin dropped at the top, ahead of the existing one.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", conversationId: helperDm },
        { kind: "channel", channelId: ops.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "ops"]);

    // Reordered, with one more pinned in between and one dragged out (unpinned).
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "channel", channelId: eng.id },
        { kind: "direct", conversationId: helperDm },
      ],
      unpinned: [{ kind: "channel", channelId: ops.id }],
    });
    expect(await pinned()).toEqual(["eng", "@helper"]);

    // A pin the arranged list does not know about (made in another tab) is kept, after the rest.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", conversationId: helperDm },
        { kind: "channel", channelId: eng.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // A channel Alice never joined cannot be pinned, and the refusal changes nothing.
    const error = await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [{ kind: "channel", channelId: bobsOwn.id }],
      unpinned: [],
    }).catch((cause: unknown) => cause);
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Another member's pins are their own.
    await arrangeConversationPins(db, workspace.id, bob.id, { pins: [], unpinned: [] });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Dragging the only arranged row out: the rest close up from the first place.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [],
      unpinned: [{ kind: "direct", conversationId: helperDm }],
    });
    expect(await pinned()).toEqual(["eng", "ops"]);
    expect(
      (await channels.list(workspace.id, alice.id))
        .filter((channel) => channel.pinned)
        .map((channel) => channel.pinSortOrder),
    ).toEqual([0, 1]);

    // A menu pin and a drag by the same member at the same moment both complete: they wait for
    // each other instead of deadlocking.
    for (let round = 0; round < 15; round += 1) {
      await Promise.all([
        channels.setUserPinned(workspace.id, alice.id, ops.id, round % 2 === 0),
        directs.setPinned(workspace.id, alice.id, helperDm, round % 2 === 1),
        arrangeConversationPins(db, workspace.id, alice.id, {
          pins: [
            { kind: "channel", channelId: ops.id },
            { kind: "channel", channelId: eng.id },
          ],
          unpinned: [],
        }),
      ]);
    }
    // Whichever finished last, the drag left ops and eng pinned, in that order, with no gaps.
    const [channelRows, preferences] = await Promise.all([
      channels.list(workspace.id, alice.id),
      directs.list(workspace.id, alice.id),
    ]);
    const orders = [
      ...channelRows.flatMap((channel) => (channel.pinned ? [channel.pinSortOrder!] : [])),
      ...preferences.pinned.map((pin) => pin.sortOrder),
    ].sort((left, right) => left - right);
    expect(orders).toEqual([...orders.keys()]);
    expect((await pinned()).filter((name) => name !== "@helper")).toEqual(["ops", "eng"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
