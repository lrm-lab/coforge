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
