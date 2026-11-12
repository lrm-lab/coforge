import { afterAll, beforeAll, expect, test } from "bun:test";
import { lockComments } from "#src/server/artifacts/artifact-comment-write.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

/**
 * Comments on artifacts, as an Agent writes them (`comment`): a comment is about the whole
 * artifact or a file, a reply joins its thread, and what a comment takes is refused before it is
 * stored. Reading them is `agent-artifact-comment-reads.integration.ts`.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cm");
});
afterAll(() => f.cleanup());

const comment = (agentId: string, artifact: string, body: string, extra: object = {}) =>
  f.post(agentId, { operation: "comment", artifact, body, idempotencyKey: f.key(), ...extra });
const comments = (agentId: string, artifact: string, extra: object = {}) =>
  f.post(agentId, { operation: "comments", artifact, ...extra });
/** Reads what others wrote, as an Agent must before it comments after them. */
const catchUp = (agentId: string, artifact: string) => comments(agentId, artifact);
const bodies = (answer: { body: Record<string, any> }) =>
  (answer.body.comments as { body?: string }[]).map((entry) => entry.body);

test("a comment says who wrote it, on which version, where, and starts a thread of its own", async () => {
  const artifact = await f.make("Plain comment");
  const answer = await comment(f.agents.reader, artifact, "  Why three lines?  ", {
    path: "plan.md",
    anchor: { type: "lines", data: { start: 2, end: 3 } },
  });
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    author: { kind: "agent", name: "Reader Bot" },
    version: 1,
    path: "plan.md",
    anchor: { type: "lines", data: { start: 2, end: 3 } },
    replyTo: null,
    body: "Why three lines?",
    editedAt: null,
    reviewId: null,
    resolvedAt: null,
    resolvedBy: null,
  });
  expect(answer.body.id).toBeString();
  expect(answer.body.createdAt).toBeString();
  const whole = await comment(f.agents.reader, artifact, "Overall: good.");
  expect(whole.body).toMatchObject({ path: null, anchor: null, replyTo: null });
});

test("a comment is refused when its body, anchor, path, version or target is wrong", async () => {
  const artifact = await f.make("Refused comments");
  const refused = async (extra: object, body = "Fine.") => {
    const answer = await comment(f.agents.reader, artifact, body, extra);
    expect(answer.status).toBe(400);
    return answer.body;
  };
  await refused({}, "   ");
  await refused({}, "x".repeat(8001));
  // Text with a NUL would be stored as binary: refused in the body and in every anchor string.
  await refused({}, "a\u0000b");
  for (const data of [
    { quote: "a\u0000b" },
    { quote: "ok", prefix: "a\u0000b" },
    { quote: "ok", suffix: "a\u0000b" },
  ])
    await refused({ path: "plan.md", anchor: { type: "text", data } });
  await refused({ path: "plan.md", anchor: { type: "element", data: { selector: "a\u0000b" } } });
  await refused({
    path: "plan.md",
    anchor: { type: "element", data: { selector: "h1", quote: "a\u0000b" } },
  });
  expect((await comment(f.agents.reader, artifact, "x".repeat(8000))).status).toBe(200);
  // An anchor points into a file: it needs a path, a valid shape, and at most 4 KiB.
  await refused({ anchor: { type: "lines", data: { start: 1, end: 1 } } });
  await refused({ path: "plan.md", anchor: { type: "lines", data: { start: 3, end: 2 } } });
  await refused({ path: "plan.md", anchor: { type: "lines", data: { start: 0, end: 1 } } });
  await refused({ path: "plan.md", anchor: { type: "lines", data: { start: 1, end: 1, x: 1 } } });
  await refused({ path: "plan.md", anchor: { type: "element", data: {} } });
  await refused({ path: "plan.md", anchor: { type: "text", data: { quote: "" } } });
  await refused({ path: "plan.md", anchor: { type: "file", data: { x: 1 } } });
  await refused({ path: "plan.md", anchor: { type: "wiggle", data: {} } });
  await refused({
    path: "plan.md",
    anchor: {
      type: "text",
      data: { quote: "q".repeat(3000), prefix: "p".repeat(1000), suffix: "s".repeat(1000) },
    },
  });
  for (const anchor of [
    { type: "file", data: {} },
    { type: "element", data: { selector: "h1 > a", quote: "Plan" } },
    { type: "text", data: { quote: "two", prefix: "one\n", suffix: "\nthree" } },
  ])
    expect(
      (await comment(f.agents.reader, artifact, "Anchored.", { path: "plan.md", anchor })).status,
    ).toBe(200);
  // The path must name a file of the version, and a version must exist.
  await refused({ path: "nope.md" });
  await refused({ path: "../plan.md" });
  await refused({ version: 2 });
  expect((await comment(f.agents.reader, artifact, "On v1.", { version: 1 })).status).toBe(200);
  // A reply names a comment of this artifact.
  const stranger = await comment(f.agents.reader, await f.make("Elsewhere"), "Other artifact.");
  const missing = await comment(f.agents.reader, artifact, "Reply.", { replyTo: stranger.body.id });
  expect(missing.status).toBe(404);
  expect((await comment(f.agents.reader, artifact, "Reply.", { replyTo: f.key() })).status).toBe(
    404,
  );
});

test("a reply joins its comment's thread, inherits its path, and may say another", async () => {
  const artifact = await f.make("Threads", { "plan.md": "a\n", "data.csv": "x\n1\n" });
  const root = await comment(f.agents.reader, artifact, "Root.", { path: "plan.md" });
  await catchUp(f.agents.writer, artifact);
  const first = await comment(f.agents.writer, artifact, "First reply.", { replyTo: root.body.id });
  expect(first.body).toMatchObject({ replyTo: root.body.id, path: "plan.md", anchor: null });
  // A reply to a reply joins the same thread: its root, never the reply.
  await catchUp(f.agents.other, artifact);
  const second = await comment(f.agents.other, artifact, "Reply to a reply.", {
    replyTo: first.body.id,
  });
  expect(second.body).toMatchObject({ replyTo: root.body.id, path: "plan.md" });
  const elsewhere = await comment(f.agents.other, artifact, "About data.", {
    replyTo: root.body.id,
    path: "data.csv",
  });
  expect(elsewhere.body).toMatchObject({ replyTo: root.body.id, path: "data.csv" });
  const rows = await f.db.artifactComment.findMany({ where: { rootId: root.body.id } });
  expect(rows).toHaveLength(3);
});

test("a deleted comment shows without its text and is never unseen", async () => {
  const artifact = await f.make("Deleted");
  const gone = await f.personComments(artifact, f.alice, { body: "Secret words." });
  await f.personComments(artifact, f.alice, { body: "Kept." });
  await f.db.artifactComment.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
  const all = await comments(f.agents.reader, artifact, { all: true });
  expect(all.body.comments[0]).toMatchObject({ id: gone.id, deleted: true });
  expect(all.body.comments[0].body).toBeUndefined();
  expect(JSON.stringify(all.body)).not.toContain("Secret words.");
  expect(bodies(await comments(f.agents.reader, artifact))).toEqual(["Kept."]);
});

test("an author who no longer exists reads as someone removed", async () => {
  const artifact = await f.make("Removed author");
  await f.db.artifactComment.create({
    data: {
      artifactId: artifact,
      version: 1,
      authorAgentId: crypto.randomUUID(),
      body: "From a ghost.",
    },
  });
  const all = await comments(f.agents.reader, artifact, { all: true });
  expect(all.body.comments[0].author).toEqual({ kind: "agent", name: "someone removed" });
});

test("an artifact the Agent cannot read has no comments to write or read", async () => {
  const hidden = await f.make("Hidden", { "plan.md": "x\n" }, { target: `#${f.privateChannel}` });
  const inside = await comment(f.agents.writer, hidden, "Inside.");
  expect(inside.status).toBe(200);
  // Reads are workspace-wide now (task #20); what an Agent cannot read is a hidden home.
  const channel = await f.db.conversation.findFirstOrThrow({
    where: { workspaceId: f.workspaceId, channelName: f.privateChannel },
    select: { id: true },
  });
  await f.db.conversation.update({
    where: { id: channel.id },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    for (const body of [
      { operation: "comments", artifact: hidden },
      { operation: "comment", artifact: hidden, body: "Hi", idempotencyKey: f.key() },
      {
        operation: "review",
        artifact: hidden,
        comments: [{ body: "Hi" }],
        idempotencyKey: f.key(),
      },
      { operation: "resolve", artifact: hidden, comment: inside.body.id },
      { operation: "reopen", artifact: hidden, comment: inside.body.id },
    ])
      expect((await f.post(f.agents.reader, body)).status).toBe(404);
  } finally {
    await f.db.conversation.update({
      where: { id: channel.id },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
  // A deleted artifact is as missing.
  const live = await f.make("Soon deleted");
  await f.db.artifact.update({ where: { id: live }, data: { deletedAt: new Date() } });
  expect((await comments(f.agents.reader, live)).status).toBe(404);
  expect((await comment(f.agents.reader, live, "Late.")).status).toBe(404);
});

test("a Workspace-wide artifact is commented by any Agent of the Workspace", async () => {
  const created = await f.post(f.agents.writer, {
    operation: "create",
    title: "Everyone's",
    text: "shared\n",
  });
  expect(created.status).toBe(200);
  expect((await comment(f.agents.reader, created.body.id, "Seen.")).status).toBe(200);
});

test("comments written at once keep their order, each after the one before", async () => {
  const artifact = await f.make("Concurrent");
  const sent = await Promise.all(
    Array.from({ length: 12 }, (_, index) => comment(f.agents.reader, artifact, `n${index}`)),
  );
  expect(sent.every((answer) => answer.status === 200)).toBe(true);
  const rows = await f.db.artifactComment.findMany({
    where: { artifactId: artifact },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const times = rows.map((row) => row.createdAt.getTime());
  expect(new Set(times).size).toBe(12);
  expect(times).toEqual([...times].sort((a, b) => a - b));
});

test("a thread, a review and a position go when the artifact is deleted for good", async () => {
  const artifact = await f.make("Cascade");
  const root = await comment(f.agents.reader, artifact, "Root.");
  await catchUp(f.agents.writer, artifact);
  await comment(f.agents.writer, artifact, "Reply.", { replyTo: root.body.id });
  await f.post(f.agents.writer, {
    operation: "review",
    artifact,
    comments: [{ body: "One" }, { body: "Two" }],
    idempotencyKey: f.key(),
  });
  await comments(f.agents.reader, artifact);
  // The Writer Bot read the thread before replying, and the Reader Bot after.
  expect(await f.db.artifactCommentPosition.count({ where: { artifactId: artifact } })).toBe(2);
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(4);
  expect(await f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(1);
  await f.db.artifact.delete({ where: { id: artifact } });
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await f.db.artifactCommentPosition.count({ where: { artifactId: artifact } })).toBe(0);
});

test("a comment retried with its key is the same comment, and the key with other words is refused", async () => {
  const artifact = await f.make("Replay");
  const key = f.key();
  const body = { operation: "comment", artifact, body: "Once.", idempotencyKey: key };
  const first = await f.post(f.agents.reader, body);
  const again = await f.post(f.agents.reader, body);
  expect(again.status).toBe(200);
  expect(again.body.id).toBe(first.body.id);
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(1);
  const changed = await f.post(f.agents.reader, { ...body, body: "Twice." });
  expect(changed.status).toBe(409);
  // The same key from another Agent is its own comment.
  expect((await f.post(f.agents.other, body)).body.id).not.toBe(first.body.id);
});

test("a reply naming an older version needs its file in that version, as a comment on a file does", async () => {
  const artifact = await f.make("Reply versions", { "plan.md": "a\n", "data.csv": "x\n" });
  const root = await comment(f.agents.writer, artifact, "On data.", { path: "data.csv" });
  await catchUp(f.agents.reader, artifact);
  // Version 2 no longer has data.csv.
  expect(
    (await f.pushFiles(artifact, f.agents.writer, {}, { delete: ["data.csv"] })).body.status,
  ).toBe("created");
  await catchUp(f.agents.reader, artifact);
  const refused = await comment(f.agents.reader, artifact, "Still there?", {
    replyTo: root.body.id,
    version: 2,
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("(artifact-comment-path)");
  expect(refused.body.error).toContain("version 2 has no file data.csv");
  const onV1 = await comment(f.agents.reader, artifact, "On v1.", {
    replyTo: root.body.id,
    version: 1,
  });
  expect(onV1.status).toBe(200);
  expect(onV1.body).toMatchObject({ path: "data.csv", version: 1 });
});

test("a comment is written on the version the artifact has once it holds the comment lock", async () => {
  const artifact = await f.make("Lock-time version");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = f.db.$transaction(async (tx) => {
    await lockComments(tx, artifact);
    locked();
    await held;
  });
  await isLocked;
  const pending = comment(f.agents.reader, artifact, "Waiting for the lock.");
  // The comment is blocked on the lock once its request waits on an advisory lock.
  await f.waitForLockWaiter();
  await f.db.artifact.update({ where: { id: artifact }, data: { currentVersion: 2 } });
  release();
  await holder;
  expect((await pending).body).toMatchObject({ version: 2 });
});
