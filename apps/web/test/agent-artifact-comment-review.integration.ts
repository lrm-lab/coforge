import { afterAll, beforeAll, expect, test } from "bun:test";
import { canResolveArtifactComment } from "#src/server/artifacts/artifact-comment-access.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

/**
 * Reviews (several comments, all or nothing) and resolving a thread: who may, what a note does,
 * and that a reply to a resolved thread reopens it.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cr");
});
afterAll(() => f.cleanup());

const comment = (agentId: string, artifact: string, body: string, extra: object = {}) =>
  f.post(agentId, { operation: "comment", artifact, body, idempotencyKey: f.key(), ...extra });
/** Reads what others wrote, as an Agent must before it comments after them. */
const catchUp = (agentId: string, artifact: string) =>
  f.post(agentId, { operation: "comments", artifact });
const review = (agentId: string, artifact: string, extra: object) =>
  f.post(agentId, { operation: "review", artifact, idempotencyKey: f.key(), ...extra });

test("a review lands its comments together under one summary, and comments reads it back", async () => {
  const artifact = await f.make("Review", { "plan.md": "a\n", "data.csv": "x\n" });
  const root = await comment(f.agents.writer, artifact, "Open question.", { path: "plan.md" });
  await catchUp(f.agents.reader, artifact);
  const answer = await review(f.agents.reader, artifact, {
    body: "Three notes.",
    comments: [
      { body: "Plan note", path: "plan.md", anchor: { type: "lines", data: { start: 1, end: 1 } } },
      { body: "Whole note" },
      { body: "Answer", replyTo: root.body.id },
    ],
  });
  expect(answer.status).toBe(200);
  expect(answer.body.review).toMatchObject({
    version: 1,
    body: "Three notes.",
    author: { kind: "agent", name: "Reader Bot" },
  });
  const ids = answer.body.comments.map((entry: { id: string }) => entry.id);
  expect(answer.body.comments.map((entry: { body: string }) => entry.body)).toEqual([
    "Plan note",
    "Whole note",
    "Answer",
  ]);
  expect(
    answer.body.comments.every(
      (entry: { reviewId: string }) => entry.reviewId === answer.body.review.id,
    ),
  ).toBe(true);
  expect(answer.body.comments[2]).toMatchObject({ replyTo: root.body.id, path: "plan.md" });
  const read = await f.post(f.agents.other, {
    operation: "comments",
    artifact,
    review: answer.body.review.id,
  });
  expect(read.body.review).toMatchObject({ id: answer.body.review.id, body: "Three notes." });
  expect(read.body.comments.map((entry: { id: string }) => entry.id)).toEqual(ids);
  // Reading a review marks nothing seen.
  const unseen = await f.post(f.agents.other, { operation: "comments", artifact });
  expect(unseen.body.comments).toHaveLength(4);
  expect(
    (await f.post(f.agents.other, { operation: "comments", artifact, review: f.key() })).status,
  ).toBe(404);
});

test("a review with one bad comment writes nothing and names that comment's index", async () => {
  const artifact = await f.make("Atomic review");
  for (const [comments, index] of [
    [[{ body: "ok" }, { body: "bad path", path: "nope.md" }, { body: "ok" }], 1],
    [
      [{ body: "ok" }, { body: "ok" }, { body: "bad anchor", anchor: { type: "file", data: {} } }],
      2,
    ],
    [[{ body: "bad reply", replyTo: crypto.randomUUID() }], 0],
  ] as const) {
    const answer = await review(f.agents.reader, artifact, { comments });
    expect([400, 404]).toContain(answer.status);
    expect(answer.body.details).toMatchObject({ index });
    expect(answer.body.error).toContain(`comments[${index}]`);
  }
  // Rules the shape checks catch name the index too, in the field they refuse.
  const blank = await review(f.agents.reader, artifact, {
    comments: [{ body: "ok" }, { body: " " }],
  });
  expect(blank.status).toBe(400);
  expect(blank.body.error).toContain("comments.1.body");
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
});

test("a review takes one to fifty comments", async () => {
  const artifact = await f.make("Review sizes");
  expect((await review(f.agents.reader, artifact, { comments: [] })).status).toBe(400);
  const fifty = Array.from({ length: 50 }, (_, index) => ({ body: `n${index}` }));
  const landed = await review(f.agents.reader, artifact, { comments: fifty });
  expect(landed.status).toBe(200);
  expect(landed.body.comments.map((entry: { body: string }) => entry.body)).toEqual(
    fifty.map((entry) => entry.body),
  );
  // One insert for all fifty, and each id is the time-ordered UUIDv7 the schema generates.
  expect(landed.body.comments.every((entry: { id: string }) => entry.id[14] === "7")).toBe(true);
  const times = (
    await f.db.artifactComment.findMany({
      where: { reviewId: landed.body.review.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map((row) => row.body);
  expect(times).toEqual(fifty.map((entry) => entry.body));
  expect(
    (await review(f.agents.reader, artifact, { comments: [...fifty, { body: "51" }] })).status,
  ).toBe(400);
});

test("a review retried with its key replays; the key with other comments is refused", async () => {
  const artifact = await f.make("Review replay");
  const body = {
    operation: "review",
    artifact,
    body: "Notes",
    comments: [{ body: "One" }, { body: "Two" }],
    idempotencyKey: f.key(),
  };
  const first = await f.post(f.agents.reader, body);
  const again = await f.post(f.agents.reader, body);
  expect(again.status).toBe(200);
  expect(again.body.review.id).toBe(first.body.review.id);
  expect(again.body.comments.map((entry: { id: string }) => entry.id)).toEqual(
    first.body.comments.map((entry: { id: string }) => entry.id),
  );
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(2);
  const changed = await f.post(f.agents.reader, { ...body, comments: [{ body: "One" }] });
  expect(changed.status).toBe(409);
});

test("resolve closes a thread by its root, and a reply cannot be resolved", async () => {
  const artifact = await f.make("Resolve");
  const root = await comment(f.agents.reader, artifact, "Is this right?");
  await catchUp(f.agents.writer, artifact);
  const reply = await comment(f.agents.writer, artifact, "Yes.", { replyTo: root.body.id });
  const asReply = await f.post(f.agents.reader, {
    operation: "resolve",
    artifact,
    comment: reply.body.id,
  });
  expect(asReply.status).toBe(400);
  expect(asReply.body.error).toContain(root.body.id);
  const done = await f.post(f.agents.reader, {
    operation: "resolve",
    artifact,
    comment: root.body.id,
  });
  expect(done.status).toBe(200);
  expect(done.body.changed).toBe(true);
  expect(done.body.comment).toMatchObject({
    id: root.body.id,
    resolvedBy: { kind: "agent", name: "Reader Bot" },
  });
  expect(done.body.comment.resolvedAt).toBeString();
  const all = await f.post(f.agents.other, { operation: "comments", artifact, all: true });
  expect(all.body.comments[0].resolvedAt).toBe(done.body.comment.resolvedAt);
  expect(all.body.comments[1].resolvedAt).toBeNull();
  // Again: nothing changes, and a note is not posted.
  const twice = await f.post(f.agents.reader, {
    operation: "resolve",
    artifact,
    comment: root.body.id,
    note: "Duplicate note",
  });
  expect(twice.body).toMatchObject({ changed: false });
  expect(twice.body.note).toBeUndefined();
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(2);
  expect(
    (
      await f.post(f.agents.reader, {
        operation: "resolve",
        artifact,
        comment: crypto.randomUUID(),
      })
    ).status,
  ).toBe(404);
});

test("a note is posted first, as a reply, and the thread then closes", async () => {
  const artifact = await f.make("Resolve with a note");
  const root = await comment(f.agents.reader, artifact, "Typo on line 2.");
  const done = await f.post(f.agents.reader, {
    operation: "resolve",
    artifact,
    comment: root.body.id,
    note: "Fixed in version 2.",
  });
  expect(done.body.changed).toBe(true);
  expect(done.body.note).toMatchObject({ body: "Fixed in version 2.", replyTo: root.body.id });
  const rows = await f.db.artifactComment.findMany({
    where: { artifactId: artifact },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  expect(rows.map((row) => row.body)).toEqual(["Typo on line 2.", "Fixed in version 2."]);
  expect(rows[0]!.resolvedAt).not.toBeNull();
  expect(rows[1]!.createdAt.getTime()).toBeLessThanOrEqual(rows[0]!.resolvedAt!.getTime());
});

test("reopen clears the resolution of a root; a reply to a resolved thread reopens it too", async () => {
  const artifact = await f.make("Reopen");
  const root = await comment(f.agents.reader, artifact, "Question.");
  await f.post(f.agents.reader, { operation: "resolve", artifact, comment: root.body.id });
  const reopened = await f.post(f.agents.reader, {
    operation: "reopen",
    artifact,
    comment: root.body.id,
  });
  expect(reopened.body).toMatchObject({
    changed: true,
    comment: { resolvedAt: null, resolvedBy: null },
  });
  expect(
    (await f.post(f.agents.reader, { operation: "reopen", artifact, comment: root.body.id })).body
      .changed,
  ).toBe(false);
  await catchUp(f.agents.writer, artifact);
  const reply = await comment(f.agents.writer, artifact, "Not so fast.", { replyTo: root.body.id });
  await f.post(f.agents.reader, { operation: "resolve", artifact, comment: root.body.id });
  // Resolved again, then a reply on the thread: open again.
  await catchUp(f.agents.other, artifact);
  await comment(f.agents.other, artifact, "Wait.", { replyTo: reply.body.id });
  expect(
    (await f.db.artifactComment.findUniqueOrThrow({ where: { id: root.body.id } })).resolvedAt,
  ).toBeNull();
  const reply2 = await f.post(f.agents.reader, {
    operation: "reopen",
    artifact,
    comment: reply.body.id,
  });
  expect(reply2.status).toBe(400);
});

test("who may resolve: the thread's author, the artifact's author, an Agent's owner, an admin", async () => {
  const artifact = await f.make("Permissions");
  // The Writer Bot made the artifact; the Reader Bot started the thread; the Other Bot is neither.
  const root = await comment(f.agents.reader, artifact, "Thread by the reader.");
  const resolve = (agentId: string, id = root.body.id) =>
    f.post(agentId, { operation: "resolve", artifact, comment: id });
  const refused = await resolve(f.agents.other);
  expect(refused.status).toBe(403);
  // An Agent is never a Workspace owner or admin: the refusal does not offer it that way out.
  expect(refused.body.error).not.toMatch(/admin|owner/i);
  expect(refused.body.error).toContain("author");
  expect(
    (await f.post(f.agents.other, { operation: "reopen", artifact, comment: root.body.id })).status,
  ).toBe(403);
  expect((await resolve(f.agents.writer)).body.changed).toBe(true);
  await catchUp(f.agents.other, artifact);
  const second = await comment(f.agents.other, artifact, "Thread by the other bot.");
  expect(second.status).toBe(200);
  expect((await resolve(f.agents.reader, second.body.id)).status).toBe(403);
  expect((await resolve(f.agents.other, second.body.id)).body.changed).toBe(true);
});

test("a person resolves as the thread's author, the artifact's author, the authoring Agent's owner, or an admin", async () => {
  const artifact = await f.make("People resolve");
  const row = await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } });
  const artifactAuthor = { authorUserId: row.authorUserId, authorAgentId: row.authorAgentId };
  const thread = (author: { authorUserId?: string | null; authorAgentId?: string | null }) => ({
    authorUserId: null,
    authorAgentId: null,
    ...author,
  });
  const can = (userId: string, root = thread({})) =>
    canResolveArtifactComment(f.db, f.workspaceId, { userId }, { artifact: artifactAuthor, root });
  // Alice owns the Workspace and the Writer Bot (the artifact's author).
  expect(await can(f.alice)).toBe(true);
  expect(await can(f.bob)).toBe(false);
  expect(await can(f.bob, thread({ authorUserId: f.bob }))).toBe(true);
  const made = await f.db.artifact.update({
    where: { id: artifact },
    data: { authorAgentId: null, authorUserId: f.bob },
  });
  expect(
    await canResolveArtifactComment(
      f.db,
      f.workspaceId,
      { userId: f.bob },
      { artifact: { authorUserId: made.authorUserId, authorAgentId: null }, root: thread({}) },
    ),
  ).toBe(true);
  expect(
    await canResolveArtifactComment(
      f.db,
      f.workspaceId,
      { agentId: f.agents.reader },
      { artifact: artifactAuthor, root: thread({ authorUserId: f.bob }) },
    ),
  ).toBe(false);
});
