import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("@-completion offers the Workspace's people and public Agents outside the channel, never a member, the viewer, a private or deleted Agent, or another Workspace", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `oa${suffix}`, username: `oa${suffix}` },
  });
  const bob = await db.user.create({ data: { username: `ob${suffix}`, displayName: "Bob" } });
  const carol = await db.user.create({
    data: { displayName: `oc${suffix}`, username: `oc${suffix}` },
  });
  const stranger = await db.user.create({
    data: { displayName: `os${suffix}`, username: `os${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Outsiders",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  const other = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Other",
      members: { create: { userId: stranger.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string, extra: object = {}) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: alice.id,
          computerId: computer.id,
          name,
          displayName: name,
          description: `${name} helps`,
          runtimeConfig: {},
          ...extra,
        },
      });
    const helper = await agent("helper");
    await agent("mine", { visibility: "private" });
    await agent("gone", { deletedAt: new Date() });
    const member = await agent("member");
    const channels = new PublicChannels(db);
    const triage = await channels.create(workspace.id, alice.id, `outsiders-${suffix}`);
    await channels.addMembers(workspace.id, { userId: alice.id }, triage.id, {
      userIds: [carol.id],
      agentIds: [member.id],
    });

    const outsiders = await channels.mentionOutsiders(workspace.id, alice.id, triage.id);
    expect(outsiders.map((row) => [row.kind, row.id, row.handle, row.label])).toEqual([
      ["user", bob.id, `ob${suffix}`, "Bob"],
      ["agent", helper.id, "helper", "helper"],
    ]);
    expect(outsiders.every((row) => row.outsider)).toBe(true);
    expect(outsiders[1]!.description).toBe("helper helps");

    // Someone who left the channel is outside it again; a viewer outside the channel is never
    // offered to themselves.
    await db.conversationMember.updateMany({
      where: { conversationId: triage.id, userId: carol.id },
      data: { leftAt: new Date() },
    });
    expect(
      (await channels.mentionOutsiders(workspace.id, bob.id, triage.id)).map((row) => row.handle),
    ).toEqual([`oc${suffix}`, "helper"]);
    // Nobody outside the Workspace, and no channel of another Workspace, is answered.
    await expect(channels.mentionOutsiders(workspace.id, stranger.id, triage.id)).rejects.toThrow();
    await expect(channels.mentionOutsiders(other.id, stranger.id, triage.id)).rejects.toThrow();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.workspace.delete({ where: { id: other.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id, stranger.id] } } });
    await db.$disconnect();
  }
});

test("@-completion scores count only the viewer's own mentions in the channel, thread replies included", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob, carol, dana] = await Promise.all(
    ["ma", "mb", "mc", "md"].map((prefix) =>
      db.user.create({
        data: { displayName: `${prefix}${suffix}`, username: `${prefix}${suffix}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `mentions-${suffix}`,
      name: "Mentions",
      members: { create: [alice!, bob!, carol!].map((user) => ({ userId: user.id })) },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    // Dana joins the Workspace after enrollment: she can read #general without a member row.
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: dana!.id } });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, alice!.id))[0]!;
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body,
        threadRootId,
      });
    const root = await send(alice!.id, `@${bob!.username} can you look?`);
    await send(alice!.id, `@${bob!.username} following up`, root.id);
    // Carol mentions both Alice and Bob: someone else's mention never scores for Alice.
    await send(carol!.id, `@${alice!.username} @${bob!.username} on it`);

    const scores = (mentionables: { handle: string; mentionScore: number }[]) =>
      Object.fromEntries(mentionables.map((entry) => [entry.handle, entry.mentionScore]));
    const bobInTwo = { [alice!.username]: 0, [bob!.username]: 200, [carol!.username]: 0 };
    expect(scores((await channels.open(workspace.id, alice!.id, general.id)).mentionables)).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, alice!.id, general.id))).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, carol!.id, general.id))).toEqual({
      [alice!.username]: 100,
      [bob!.username]: 100,
      [carol!.username]: 0,
    });
    // A reader with no member row has mentioned no one here.
    expect(
      Object.values(scores((await channels.open(workspace.id, dana!.id, general.id)).mentionables)),
    ).toEqual([0, 0, 0]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice!, bob!, carol!, dana!].map((user) => user.id) } },
    });
    await db.$disconnect();
    redis.close();
  }
});
