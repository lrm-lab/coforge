import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { noticeActions } from "./helpers/artifact-notice-actions";

/**
 * A write retried after a lost answer, or whose follow failed after it committed: the write
 * stands, and the retry delivers what the first attempt could not and nothing twice. Who is told
 * at all is `agent-artifact-notices.integration.ts`.
 */
let f: CommentsFixture;
const names = { writer: "", reader: "", other: "", alice: "" };
beforeAll(async () => {
  f = await commentsFixture("nt");
  for (const key of ["writer", "reader", "other"] as const)
    names[key] = (await f.db.agent.findUniqueOrThrow({ where: { id: f.agents[key] } })).name;
  names.alice = (await f.db.user.findUniqueOrThrow({ where: { id: f.alice } })).username;
});
afterAll(() => f.cleanup());

const { comment, catchUp, follow, told } = noticeActions(() => f);

test("a replayed comment stores no second notice", async () => {
  const artifact = await f.make("Replayed");
  const body = { operation: "comment", artifact, body: "Once.", idempotencyKey: f.key() };
  const first = await f.post(f.agents.reader, body);
  expect(first.body.notified).toHaveLength(1);
  const replay = await f.post(f.agents.reader, body);
  expect(replay.status).toBe(200);
  expect(replay.body.id).toBe(first.body.id);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("a replay delivers what the first attempt could not", async () => {
  const artifact = await f.make("Delivered by the replay");
  const body = { operation: "comment", artifact, body: "Twice.", idempotencyKey: f.key() };
  f.noticeDelivery.down = true;
  try {
    const first = await f.post(f.agents.reader, body);
    expect(first.body.notNotified).toEqual([{ name: names.writer, reason: "delivery-failed" }]);
  } finally {
    f.noticeDelivery.down = false;
  }
  expect(await told(f.agents.writer, artifact)).toHaveLength(0);
  const replay = await f.post(f.agents.reader, body);
  expect(replay.body.notified).toEqual([{ name: names.writer, reason: "subscribed" }]);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("a replayed review, resolve and push deliver what the first attempt could not", async () => {
  const artifact = await f.make("Everything replayed", { "plan.md": "plan\n", "data.csv": "x\n" });
  await follow(f.agents.reader, artifact);
  const thread = await comment(f.agents.reader, artifact, "Please fix.");
  await catchUp(f.agents.writer, artifact);
  const review = {
    operation: "review",
    artifact,
    comments: [{ body: "One" }],
    idempotencyKey: f.key(),
  };
  const resolve = { operation: "resolve", artifact, comment: thread.body.id, note: "Done." };
  const push = {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: f.key(),
    files: await f.manifestOf(f.agents.reader, { "data.csv": "x\ny\n" }),
  };
  f.noticeDelivery.down = true;
  try {
    await f.post(f.agents.reader, review);
    await catchUp(f.agents.writer, artifact);
    await f.post(f.agents.writer, resolve);
    await catchUp(f.agents.reader, artifact);
    await f.post(f.agents.reader, push);
  } finally {
    f.noticeDelivery.down = false;
  }
  const kept = (await told(f.agents.writer, artifact)).length;
  expect((await f.post(f.agents.reader, review)).body.notified).toHaveLength(1);
  expect((await f.post(f.agents.writer, resolve)).body.notified).toContainEqual({
    name: names.reader,
    reason: "your_comment_resolved",
  });
  expect((await f.post(f.agents.reader, push)).body.notified).toEqual([
    { name: names.writer, reason: "your_file_changed" },
  ]);
  const delivered = await told(f.agents.writer, artifact);
  expect(delivered).toHaveLength(kept + 2);
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);

  await f.post(f.agents.reader, review);
  await f.post(f.agents.writer, resolve);
  await f.post(f.agents.reader, push);
  expect(await told(f.agents.writer, artifact)).toHaveLength(kept + 2);
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);
});

test("follows that fail after the commit do not fail the write", async () => {
  const artifact = await f.make("Follow down");
  const brokenFollows = new Proxy(f.db, {
    get: (target, property) =>
      property === "artifactFollow"
        ? { findUnique: () => Promise.reject(new Error("follows are down")) }
        : Reflect.get(target, property),
  });
  const answer = await f.post(
    f.agents.other,
    { operation: "comment", artifact, body: "Still stored.", idempotencyKey: f.key() },
    { db: brokenFollows },
  );
  expect(answer.status).toBe(200);
  expect(answer.body.newlyFollowing).toBeUndefined();
  const stored = await f.post(f.agents.other, { operation: "comments", artifact, all: true });
  expect(stored.body.comments.map((entry: { body: string }) => entry.body)).toEqual([
    "Still stored.",
  ]);
});
