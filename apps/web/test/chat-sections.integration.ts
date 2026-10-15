import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ChatSections } from "#src/server/conversations/chat-sections.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function withMember(
  run: (
    sections: ChatSections,
    db: PrismaClient,
    scope: { workspaceId: string; userId: string },
  ) => Promise<void>,
) {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `section-order-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Section order", members: { create: { userId: user.id } } },
  });
  try {
    await run(new ChatSections(db, workspace.id, user.id), db, {
      workspaceId: workspace.id,
      userId: user.id,
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}

test("section names accept 18 characters and reject 19", () =>
  withMember(async (sections) => {
    const section = await sections.create({ name: "abcdefghijklmnopqr", emoji: null });
    expect((await sections.list())[0]?.name).toBe("abcdefghijklmnopqr");
    await expect(sections.create({ name: "abcdefghijklmnopqrs", emoji: null })).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(sections.update(section.id, { name: "abcdefghijklmnopqrs" })).rejects.toThrow(
      "INVALID_INPUT",
    );
  }));

test("dragged section and conversation orders survive a new read without dropping unseen entries", () =>
  withMember(async (sections, db, scope) => {
    const first = await sections.create({ name: "First", emoji: null });
    const second = await sections.create({ name: "Second", emoji: null });
    const third = await sections.create({ name: "Third", emoji: null });
    await sections.reorder([third.id, first.id]);
    expect((await sections.list()).map((section) => section.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
    const conversations = [];
    for (const name of ["alpha", "beta", "gamma"]) {
      conversations.push(
        await db.conversation.create({
          data: {
            workspaceId: scope.workspaceId,
            channelName: name,
            members: { create: { userId: scope.userId } },
          },
        }),
      );
    }
    const [a, b, c] = conversations;
    await sections.move(a!.id, first.id);
    await sections.move(b!.id, first.id);
    await sections.move(c!.id, first.id, a!.id);
    const fresh = new ChatSections(db, scope.workspaceId, scope.userId);
    expect(
      (await fresh.list()).find((section) => section.id === first.id)?.conversationIds,
    ).toEqual([c!.id, a!.id, b!.id]);
    await sections.move(b!.id, third.id);
    expect(
      (await fresh.list()).find((section) => section.id === first.id)?.conversationIds,
    ).toEqual([c!.id, a!.id]);
    expect((await fresh.list())[0]?.conversationIds).toEqual([b!.id]);
    await expect(sections.reorder([crypto.randomUUID()])).rejects.toThrow("NOT_FOUND");
  }));

test("a section's sort and the sidebar's section order, built-in sections included, survive a new read", () =>
  withMember(async (sections, db, scope) => {
    const first = await sections.create({ name: "First", emoji: null });
    const second = await sections.create({ name: "Second", emoji: null });
    expect(await sections.order()).toEqual([]);

    await sections.update(first.id, { sortMode: "alpha" });
    await expect(
      sections.update(first.id, { sortMode: "newest" as unknown as "alpha" }),
    ).rejects.toThrow("INVALID_INPUT");

    // Only custom ids: the custom sections reorder and no preference is written.
    await sections.reorder([second.id, first.id]);
    expect(await sections.order()).toEqual([]);

    const order = ["channels", first.id, "pinned", second.id, "agents"];
    await sections.reorder(order);
    const fresh = new ChatSections(db, scope.workspaceId, scope.userId);
    expect(await fresh.order()).toEqual(order);
    expect((await fresh.list()).map((section) => [section.id, section.sortMode])).toEqual([
      [first.id, "alpha"],
      [second.id, "manual"],
    ]);
    await expect(sections.reorder(["channels", "channels"])).rejects.toThrow("INVALID_INPUT");
  }));

test("personal Chat sections survive a new read with their name, emoji and collapse state", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `sections-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Sections", members: { create: { userId: user.id } } },
  });
  try {
    const sections = new ChatSections(db, workspace.id, user.id);
    expect(await sections.list()).toEqual([]);
    const section = await sections.create({ name: "  项目 Alpha  ", emoji: "🚀" });
    expect(await new ChatSections(db, workspace.id, user.id).list()).toEqual([
      {
        id: section.id,
        name: "项目 Alpha",
        emoji: "🚀",
        collapsed: false,
        sortOrder: 0,
        sortMode: "manual",
        conversationIds: [],
      },
    ]);
    await sections.update(section.id, { name: "Release", emoji: null, collapsed: true });
    expect(await sections.list()).toEqual([
      {
        id: section.id,
        name: "Release",
        emoji: null,
        collapsed: true,
        sortOrder: 0,
        sortMode: "manual",
        conversationIds: [],
      },
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("channels and DMs move between personal sections and survive a section's deletion", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `section-move-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Move", members: { create: { userId: user.id } } },
  });
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "release",
        members: { create: { userId: user.id } },
      },
    });
    const dm = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: `user:${user.id}|user:${user.id}`,
        members: { create: { userId: user.id } },
      },
    });
    const sections = new ChatSections(db, workspace.id, user.id);
    const first = await sections.create({ name: "First", emoji: null });
    const second = await sections.create({ name: "Second", emoji: null });
    await sections.move(channel.id, first.id);
    await sections.move(dm.id, first.id);
    expect((await sections.list())[0]?.conversationIds.sort()).toEqual([channel.id, dm.id].sort());
    await sections.move(channel.id, second.id);
    expect((await sections.list()).map((section) => section.conversationIds)).toEqual([
      [dm.id],
      [channel.id],
    ]);
    await sections.remove(second.id);
    expect((await sections.list()).map((section) => section.id)).toEqual([first.id]);
    // Reassigning proves deletion kept the conversation and the viewer's membership usable.
    await sections.move(channel.id, first.id);
    await sections.move(dm.id, null);
    expect((await new ChatSections(db, workspace.id, user.id).list())[0]?.conversationIds).toEqual([
      channel.id,
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("sections isolate members and Workspaces, reject inaccessible conversations and invalid names/icons", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `section-alice-${suffix}` } });
  const bob = await db.user.create({ data: { username: `section-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Private sections",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const other = await db.workspace.create({
    data: { slug: `other-${suffix}`, name: "Other", members: { create: { userId: alice.id } } },
  });
  try {
    const a = new ChatSections(db, workspace.id, alice.id);
    const b = new ChatSections(db, workspace.id, bob.id);
    const elsewhere = new ChatSections(db, other.id, alice.id);
    const section = await a.create({ name: "Personal", emoji: "📁" });
    expect(await b.list()).toEqual([]);
    expect(await elsewhere.list()).toEqual([]);
    await expect(b.update(section.id, { name: "Stolen" })).rejects.toThrow("NOT_FOUND");
    await expect(elsewhere.remove(section.id)).rejects.toThrow("NOT_FOUND");
    const foreign = await db.conversation.create({
      data: {
        workspaceId: other.id,
        channelName: "foreign",
        members: { create: { userId: alice.id } },
      },
    });
    await expect(a.move(foreign.id, section.id)).rejects.toThrow("ACCESS_DENIED");
    await expect(b.move(foreign.id, section.id)).rejects.toThrow("NOT_FOUND");
    await expect(a.create({ name: "  ", emoji: null })).rejects.toThrow("INVALID_INPUT");
    await expect(a.create({ name: "Name", emoji: "not-an-emoji" })).rejects.toThrow(
      "INVALID_INPUT",
    );
    await db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: alice.id } },
    });
    await expect(a.list()).rejects.toThrow("ACCESS_DENIED");
    expect(await b.list()).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.workspace.delete({ where: { id: other.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("moving a closed pinned channel into a section keeps it visible and removes its pin", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `section-pin-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Pins", members: { create: { userId: user.id } } },
  });
  try {
    const channels = new PublicChannels(db);
    const channel = await channels.create(workspace.id, user.id, "release");
    await channels.setUserPinned(workspace.id, user.id, channel.id, true);
    await channels.setUserHidden(workspace.id, user.id, channel.id, true);
    const sections = new ChatSections(db, workspace.id, user.id);
    const section = await sections.create({ name: "Release", emoji: null });
    await sections.move(channel.id, section.id);
    const listed = (await channels.list(workspace.id, user.id)).find(
      (row) => row.id === channel.id,
    );
    expect(listed).toMatchObject({ pinned: false, hidden: false });
    expect((await sections.list())[0]?.conversationIds).toEqual([channel.id]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
