import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

/**
 * Following an artifact: `follow` and `unfollow` as an Agent asks for them, and the follow a push,
 * a comment or a review makes unless the Agent unfollowed on purpose. Who is told of what is
 * `agent-artifact-notices.integration.ts`.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("fo");
});
afterAll(() => f.cleanup());

const state = (artifactId: string, agentId: string) =>
  f.db.artifactFollow.findUnique({
    where: { artifactId_agentId: { artifactId, agentId } },
    select: { following: true, unfollowedAt: true },
  });
const op = (agentId: string, operation: "follow" | "unfollow", artifact: string) =>
  f.post(agentId, { operation, artifact });

test("follow and unfollow answer the artifact and the state, and repeat as they were", async () => {
  const artifact = await f.make("Follow me");
  const followed = await op(f.agents.reader, "follow", artifact);
  expect(followed.status).toBe(200);
  expect(followed.body).toEqual({
    artifact: { id: artifact, name: "follow-me", title: "Follow me", currentVersion: 1 },
    following: true,
  });
  expect(await state(artifact, f.agents.reader)).toMatchObject({
    following: true,
    unfollowedAt: null,
  });
  expect((await op(f.agents.reader, "follow", artifact)).body.following).toBe(true);

  const unfollowed = await op(f.agents.reader, "unfollow", artifact);
  expect(unfollowed.body).toMatchObject({ following: false, artifact: { id: artifact } });
  const first = await state(artifact, f.agents.reader);
  expect(first).toMatchObject({ following: false });
  expect(first?.unfollowedAt).toBeInstanceOf(Date);
  expect((await op(f.agents.reader, "unfollow", artifact)).body.following).toBe(false);
  expect((await state(artifact, f.agents.reader))?.unfollowedAt).toEqual(first!.unfollowedAt);

  await op(f.agents.reader, "follow", artifact);
  expect(await state(artifact, f.agents.reader)).toMatchObject({
    following: true,
    unfollowedAt: null,
  });
});

test("an Agent that never followed can unfollow, and an unknown artifact is not found", async () => {
  const artifact = await f.make("Never followed");
  expect((await op(f.agents.other, "unfollow", artifact)).body.following).toBe(false);
  expect(await state(artifact, f.agents.other)).toMatchObject({ following: false });
  expect((await op(f.agents.other, "follow", f.key())).status).toBe(404);
  expect((await op(f.agents.other, "unfollow", f.key())).status).toBe(404);
});

test("a push that makes an artifact follows it, and says so once", async () => {
  const created = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    title: "Mine",
    target: `#${f.docsChannel}`,
    files: await f.manifestOf(f.agents.writer, { "plan.md": "a\n" }),
    entry: "plan.md",
  });
  expect(created.body.newlyFollowing).toBe(true);
  expect(await state(created.body.id, f.agents.writer)).toMatchObject({ following: true });
  const again = await f.pushText(created.body.id, f.agents.writer, "b\n");
  expect(again.body.status).toBe("created");
  expect(again.body.newlyFollowing).toBeUndefined();
});

test("a push, a comment and a review follow for the Agent, the first time only", async () => {
  const artifact = await f.make("Writes follow");
  const pushed = await f.pushText(artifact, f.agents.reader, "reader's text\n");
  expect(pushed.body.newlyFollowing).toBe(true);
  expect((await f.pushText(artifact, f.agents.reader, "again\n")).body.newlyFollowing).toBe(
    undefined,
  );

  await f.post(f.agents.other, { operation: "read", artifact });
  const commented = await f.post(f.agents.other, {
    operation: "comment",
    artifact,
    body: "Hello.",
    idempotencyKey: f.key(),
  });
  expect(commented.body.newlyFollowing).toBe(true);
  expect(await state(artifact, f.agents.other)).toMatchObject({ following: true });

  const second = await f.make("Review follows");
  const reviewed = await f.post(f.agents.other, {
    operation: "review",
    artifact: second,
    comments: [{ body: "One." }],
    idempotencyKey: f.key(),
  });
  expect(reviewed.body.newlyFollowing).toBe(true);
  expect(await state(second, f.agents.other)).toMatchObject({ following: true });
});

test("an Agent that unfollowed is not followed again by its own writes until it follows", async () => {
  const artifact = await f.make("Unfollowed");
  await op(f.agents.reader, "unfollow", artifact);
  const commented = await f.post(f.agents.reader, {
    operation: "comment",
    artifact,
    body: "Still out.",
    idempotencyKey: f.key(),
  });
  expect(commented.status).toBe(200);
  expect(commented.body.newlyFollowing).toBeUndefined();
  await f.post(f.agents.writer, { operation: "comments", artifact });
  const pushed = await f.pushText(artifact, f.agents.reader, "text\n");
  expect(pushed.body.newlyFollowing).toBeUndefined();
  expect(await state(artifact, f.agents.reader)).toMatchObject({ following: false });

  await op(f.agents.reader, "follow", artifact);
  const reviewed = await f.post(f.agents.reader, {
    operation: "review",
    artifact,
    comments: [{ body: "Back." }],
    idempotencyKey: f.key(),
  });
  expect(reviewed.body.newlyFollowing).toBeUndefined();
  expect(await state(artifact, f.agents.reader)).toMatchObject({ following: true });
});

test("a replayed write does not report following again", async () => {
  const artifact = await f.make("Replayed follow");
  const body = { operation: "comment", artifact, body: "Once.", idempotencyKey: f.key() };
  expect((await f.post(f.agents.reader, body)).body.newlyFollowing).toBe(true);
  expect((await f.post(f.agents.reader, body)).body.newlyFollowing).toBeUndefined();
});
