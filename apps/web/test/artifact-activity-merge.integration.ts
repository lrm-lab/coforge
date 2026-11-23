import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentDraftInput } from "#src/features/artifacts/artifact-comment-inputs";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import { ArtifactPersonFollows } from "#src/server/artifacts/artifact-person-follows.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxCursor } from "#src/features/inbox/activity-inbox.schemas";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let comments: ArtifactPersonComments;
let follows: ArtifactPersonFollows;
let inbox: ActivityInbox;

beforeAll(async () => {
  f = await commentsFixture("pm");
  comments = new ArtifactPersonComments(f.db, f.blobs, f.notices);
  follows = new ArtifactPersonFollows(f.db, f.artifacts.reads);
  inbox = new ActivityInbox(f.db, {});
});
afterAll(() => f.cleanup());

const base = Date.now() - 3_600_000;
const at = (minutes: number) => new Date(base + minutes * 60_000);
const place = (artifactId: string) => ({
  workspaceId: f.workspaceId,
  artifactId,
  userId: f.bob,
});

async function artifactItem(title: string, minutes: number, body = "news") {
  const artifact = await f.make(title);
  await follows.set({ ...place(artifact), following: true });
  await f.db.artifactFollow.updateMany({
    where: { artifactId: artifact, userId: f.bob },
    data: { followedAt: at(-120) },
  });
  const said = await comments.post({
    workspaceId: f.workspaceId,
    artifactId: artifact,
    userId: f.alice,
    comment: commentDraftInput.parse({ body, idempotencyKey: f.key() }),
  });
  await f.db.artifactComment.update({ where: { id: said.id }, data: { createdAt: at(minutes) } });
  return `artifact:${artifact}`;
}

async function conversationItem(name: string, minutes: number) {
  const id = (
    await f.db.conversation.create({
      data: {
        workspaceId: f.workspaceId,
        channelName: `${name}-${crypto.randomUUID().slice(0, 6)}`,
      },
    })
  ).id;
  const [alice] = await Promise.all(
    [f.alice, f.bob].map((userId) =>
      f.db.conversationMember.create({
        data: { conversationId: id, workspaceId: f.workspaceId, userId },
      }),
    ),
  );
  await f.db.message.create({
    data: {
      conversationId: id,
      workspaceId: f.workspaceId,
      senderMemberId: alice!.id,
      body: "hello",
      sequence: 1,
      createdAt: at(minutes),
    },
  });
  return `conversation:${id}`;
}

test("pages merge conversation and artifact items at the cursor boundary without a skip or a repeat", async () => {
  const keys = [
    await artifactItem("A0", 0),
    await conversationItem("c1", 1),
    await artifactItem("A2", 2),
    await conversationItem("c2", 2),
    await artifactItem("A3", 3),
    await conversationItem("c3", 4),
    await artifactItem("A4", 4),
  ];
  const whole = await inbox.list(f.workspaceId, f.bob, { filter: "all", limit: 50 });
  const expected = whole.items.map((item) => item.key);
  expect([...expected].sort()).toEqual([...keys].sort());
  for (const limit of [1, 2, 3]) {
    const seen: string[] = [];
    let cursor: ActivityInboxCursor | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await inbox.list(f.workspaceId, f.bob, { filter: "all", limit, cursor });
      seen.push(...page.items.map((item) => item.key));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected);
  }
});

test("the Unread and Mentions tabs agree with their counts and the nav dot", async () => {
  const name = (await f.db.user.findUniqueOrThrow({ where: { id: f.bob } })).username;
  const mentioned = await artifactItem("Mentioned", 10, `@${name} look`);
  const plain = await artifactItem("Plain", 11);
  const read = await artifactItem("Read", 12);
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: read.slice("artifact:".length),
    throughAt: Date.now(),
  });
  const all = await inbox.list(f.workspaceId, f.bob, { filter: "all", limit: 100 });
  const unread = await inbox.list(f.workspaceId, f.bob, { filter: "unread", limit: 100 });
  const mentions = await inbox.list(f.workspaceId, f.bob, { filter: "mentions", limit: 100 });
  const dot = await inbox.navAttention(f.workspaceId, f.bob);
  const keysOf = (page: typeof all) => page.items.map((item) => item.key);
  expect(keysOf(unread)).toEqual(expect.arrayContaining([mentioned, plain]));
  expect(keysOf(unread)).not.toContain(read);
  expect(keysOf(all)).toContain(read);
  expect(keysOf(mentions)).toContain(mentioned);
  expect(keysOf(mentions)).not.toContain(plain);
  expect(all.unreadItemCount).toBe(unread.items.length);
  expect(all.unreadItemCount).toBe(dot.unreadCount ?? 0);
  expect(all.unreadMentionItemCount).toBe(mentions.items.length);
  expect(all.activeItemCount).toBe(all.items.length);
});

test("all pages put older unreads ahead of read rows and merge ties across sources", async () => {
  await inbox.markAllRead(f.workspaceId, f.bob, { before: new Date() });
  const artifact = await artifactItem("Older unread tie", -20);
  const artifactId = artifact.slice("artifact:".length);
  await f.db.artifactVersion.updateMany({ where: { artifactId }, data: { createdAt: at(-20) } });

  const tied = await conversationItem("tie", -20);
  const tiedId = tied.slice("conversation:".length);
  await f.db.message.updateMany({ where: { conversationId: tiedId }, data: { sequence: 0 } });
  await f.db.conversationMember.updateMany({
    where: { conversationId: tiedId, userId: f.bob },
    data: { readThroughSequence: -1, doneThroughSequence: -1 },
  });

  const newer = [];
  for (let index = 0; index < 33; index++) {
    const key = await conversationItem(`read-${index}`, 30 + index);
    newer.push(key);
    await f.db.conversationMember.updateMany({
      where: { conversationId: key.slice("conversation:".length), userId: f.bob },
      data: { readThroughSequence: 1 },
    });
  }

  const list = (limit: number, cursor?: ActivityInboxCursor) =>
    inbox.list(f.workspaceId, f.bob, { filter: "all", limit, cursor });
  const first = await list(1);
  expect(first.items.map((item) => item.key)).toEqual([tied]);
  expect(first.nextCursor).toMatchObject({
    order: "unread-first-v1",
    hasUnread: true,
    sequence: 0,
  });
  expect((await list(1, first.nextCursor!)).items.map((item) => item.key)).toEqual([artifact]);
  expect(
    (await list(1, { at: at(60).getTime(), sequence: 1, key: newer[30]! })).items.map(
      (item) => item.key,
    ),
  ).toEqual([tied]);

  const page = await list(30);
  const rest = await list(100, page.nextCursor!);
  const all = [...page.items, ...rest.items].map((item) => item.key);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toEqual(expect.arrayContaining([artifact, tied, ...newer]));
  expect(page.unreadItemCount).toBe(rest.unreadItemCount);
});

test("an off-page selection follows its authorized row without changing the page or its cursor", async () => {
  const reader = { workspaceId: f.workspaceId, userId: f.bob };
  const load = (selectedKey?: string, cursor?: ActivityInboxCursor) =>
    inbox.list(reader.workspaceId, reader.userId, { filter: "all", limit: 1, selectedKey, cursor });
  const selected = await artifactItem("Selected", -50);
  const other = await conversationItem("selected-channel", -48);
  await conversationItem("next-channel", 65);
  const reference = await load();
  for (const key of [selected, other]) {
    const page = await load(key);
    expect(page.selectedItem?.key).toBe(key);
    expect(page.items).toEqual(reference.items);
    expect(page.nextCursor).toEqual(reference.nextCursor);
    expect(page.unreadItemCount).toBe(reference.unreadItemCount);
    expect(page.activeItemCount).toBe(reference.activeItemCount);
    expect((await load(key, reference.nextCursor!)).selectedItem).toBeUndefined();
  }
  const artifactId = selected.slice("artifact:".length);
  await inbox.markArtifactRead(reader.workspaceId, reader.userId, {
    kind: "artifact",
    artifactId,
    throughAt: Date.now(),
  });
  expect((await load(selected)).selectedItem?.unreadCount).toBe(0);
  await follows.set({ ...place(artifactId), following: false });
  expect((await load(selected)).selectedItem).toBeUndefined();
  await f.db.conversationMember.updateMany({
    where: { userId: f.bob, conversationId: other.slice("conversation:".length) },
    data: { leftAt: new Date() },
  });
  expect((await load(other)).selectedItem).toBeUndefined();
});
