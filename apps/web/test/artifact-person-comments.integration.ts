import { afterAll, beforeAll, expect, test } from "bun:test";
import { avatarPresetReference, avatarPresets } from "#src/features/profiles/avatar-presets";
import { agentFaceUrl } from "#src/server/apps/app-logo.server";
import type { ArtifactSignalEvent } from "#src/server/artifacts/artifact-signals.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import type { CommentsFixture } from "./helpers/artifact-comments-fixture";
import { personCommentsHarness } from "./helpers/person-comments-harness";

let f: CommentsFixture;
let comments: ArtifactPersonComments;
const h = personCommentsHarness("pc", (ready) => {
  f = ready.f;
  comments = ready.comments;
});
beforeAll(h.setUp);
afterAll(h.tearDown);
const { events, place, draft, post, list, bodiesOf, noticesAbout } = h;

test("a person comments on the whole artifact and on a file, and an Agent reads who wrote it", async () => {
  const artifact = await f.make("Person comments");
  const { id } = await post(artifact, "  Looks good.  ");
  await post(artifact, "About the plan.", { path: "plan.md" });
  const page = await list(artifact);
  expect(page.total).toBe(2);
  expect(page.comments[0]).toMatchObject({
    id,
    author: { kind: "user", name: "Alice" },
    authorId: f.alice,
    mine: true,
    canResolve: true,
    body: "Looks good.",
    path: null,
    version: 1,
    replyTo: null,
  });
  expect(page.comments[1]).toMatchObject({ path: "plan.md" });
  const asBob = await list(artifact, f.bob);
  expect(asBob.comments[0]).toMatchObject({ mine: false, canResolve: false });
  const read = await f.post(f.agents.reader, {
    operation: "comments",
    artifact,
    all: true,
  });
  expect(read.body.comments[0]).toMatchObject({
    author: { kind: "user", name: "Alice" },
    body: "Looks good.",
  });
});

test("a person anchors a comment to a text quote or a line range, and an anchor needs a file", async () => {
  const artifact = await f.make("Anchors");
  const quote = {
    type: "text" as const,
    data: { quote: "two", prefix: "one\n", suffix: "\nthree" },
  };
  const lines = { type: "lines" as const, data: { start: 2, end: 3 } };
  await post(artifact, "On the quote.", { path: "plan.md", anchor: quote });
  await post(artifact, "On the lines.", { path: "plan.md", anchor: lines });
  const page = await list(artifact);
  expect(page.comments.map((comment) => ("deleted" in comment ? null : comment.anchor))).toEqual([
    quote,
    lines,
  ]);
  await expect(post(artifact, "No file.", { anchor: quote })).rejects.toMatchObject({
    errorId: "artifact-comment-anchor",
  });
  expect(() =>
    draft("Backwards.", { path: "plan.md", anchor: { type: "lines", data: { start: 3, end: 2 } } }),
  ).toThrow();
});

test("a person posts a comment on a place a page named, and an Agent reads it as a page anchor", async () => {
  const artifact = await f.make("Page places");
  const place = {
    type: "page" as const,
    data: { name: "pricing:table", label: "Pricing", quote: "Ships Friday" },
  };
  await post(artifact, "Is this still true?", { path: "plan.md", anchor: place });
  const page = await list(artifact);
  expect(page.comments[0]).toMatchObject({ path: "plan.md", anchor: place });
  const read = await f.post(f.agents.reader, { operation: "comments", artifact, all: true });
  expect(read.body.comments[0]).toMatchObject({ anchor: place, path: "plan.md" });
  const refused = (data: Record<string, unknown>) =>
    expect(() => draft("Bad.", { path: "plan.md", anchor: { type: "page", data } })).toThrow();
  refused({});
  refused({ name: "" });
  refused({ name: "has space" });
  refused({ name: "a".repeat(257) });
  refused({ name: "a", label: "x".repeat(201) });
  refused({ name: "a", quote: "x".repeat(2001) });
  refused({ name: "a", quote: "a\u0000b" });
  refused({ name: "a", selector: "h1" });
  refused({ name: "a", quote: "\u20AC".repeat(1400) });
});

test("a reply joins its thread, a retry with the same key stores once, and a reply to a deleted comment is refused", async () => {
  const artifact = await f.make("Replies");
  const root = await post(artifact, "Root.");
  const key = f.key();
  const reply = () =>
    comments.post({
      ...place(artifact, f.bob),
      comment: { body: "Reply.", replyTo: root.id, idempotencyKey: key },
    });
  const first = await reply();
  expect((await reply()).id).toBe(first.id);
  const page = await list(artifact);
  expect(page.comments).toHaveLength(2);
  expect(page.comments[1]).toMatchObject({ replyTo: root.id, author: { name: "Bob" } });
  await comments.remove({ ...place(artifact, f.bob), commentId: first.id });
  await expect(
    comments.post({ ...place(artifact), comment: draft("Late.", { replyTo: first.id }) }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("only the author edits or deletes a comment; edits are marked and deletes leave a placeholder", async () => {
  const artifact = await f.make("Edits");
  const root = await post(artifact, "Original.");
  const reply = await post(artifact, "Mine.", { replyTo: root.id }, f.bob);
  await expect(
    comments.edit({ ...place(artifact, f.bob), commentId: root.id, body: "Hijack." }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    comments.remove({ ...place(artifact, f.alice), commentId: reply.id }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await comments.edit({ ...place(artifact), commentId: root.id, body: "Reworded." });
  const edited = (await list(artifact)).comments[0]!;
  expect(edited).toMatchObject({ body: "Reworded." });
  expect((edited as { editedAt: Date | null }).editedAt).toBeInstanceOf(Date);
  await comments.remove({ ...place(artifact, f.bob), commentId: reply.id });
  const afterReplyGone = await list(artifact);
  expect(bodiesOf(afterReplyGone)).toEqual(["Reworded.", "(deleted)"]);
  expect(afterReplyGone.total).toBe(1);
  expect(await f.db.artifactComment.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({
    body: "",
    deletedAt: expect.any(Date),
  });
  await comments.remove({ ...place(artifact), commentId: root.id });
  expect(bodiesOf(await list(artifact))).toEqual([]);
  await expect(
    comments.edit({ ...place(artifact), commentId: root.id, body: "Back." }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a deleted comment with no live reply is not listed at all", async () => {
  const artifact = await f.make("Gone");
  const root = await post(artifact, "Soon gone.");
  await comments.remove({ ...place(artifact), commentId: root.id });
  const page = await list(artifact);
  expect(page.comments).toHaveLength(0);
  expect(page.total).toBe(0);
});

test("the thread's author, the artifact's owner and admins resolve; others are refused; a reply reopens", async () => {
  const artifact = await f.make("Resolving");
  const root = await post(artifact, "Please fix.", {}, f.bob);
  await comments.resolve({ ...place(artifact, f.bob), commentId: root.id });
  const resolved = (await list(artifact)).comments[0]!;
  expect(resolved).toMatchObject({ resolvedBy: { kind: "user", name: "Bob" } });
  expect((resolved as { resolvedAt: Date | null }).resolvedAt).toBeInstanceOf(Date);
  expect(await comments.resolve({ ...place(artifact, f.bob), commentId: root.id })).toEqual({
    changed: false,
  });
  await comments.reopen({ ...place(artifact, f.bob), commentId: root.id });
  expect((await list(artifact)).comments[0]).toMatchObject({ resolvedAt: null });
  const alices = await post(artifact, "Mine to close.");
  await expect(
    comments.resolve({ ...place(artifact, f.bob), commentId: alices.id }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await comments.resolve({ ...place(artifact, f.alice), commentId: root.id });
  expect((await list(artifact)).comments[0]).toMatchObject({ resolvedBy: { name: "Alice" } });
  await post(artifact, "Not done yet.", { replyTo: root.id }, f.bob);
  expect((await list(artifact)).comments[0]).toMatchObject({ resolvedAt: null });
});

test("resolving a thread an Agent started tells that Agent", async () => {
  const artifact = await f.make("Agent thread");
  const started = await f.post(f.agents.reader, {
    operation: "comment",
    artifact,
    body: "Agent's point.",
    idempotencyKey: f.key(),
  });
  await comments.resolve({ ...place(artifact), commentId: started.body.id });
  const told = await noticesAbout(f.agents.reader, artifact);
  expect(told.map((notice) => notice.body).join("\n")).toContain("Alice");
});

test("someone who cannot read the artifact is refused with nothing to learn from it", async () => {
  const artifact = await f.make("Private", undefined, { target: `#${f.privateChannel}` });
  const before = await f.db.artifactComment.count({ where: { artifactId: artifact } });
  const calls = [
    () => list(artifact, f.bob),
    () => post(artifact, "Hello?", {}, f.bob),
    () => comments.candidates(place(artifact, f.bob)),
    () => comments.willNotify({ ...place(artifact, f.bob), body: "hi" }),
    () => comments.uploadImage({ ...place(artifact, f.bob), bytes: new Uint8Array([1]) }),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(before);
});

test("every write announces to open viewers", async () => {
  const artifact = await f.make("Live");
  events.length = 0;
  const root = await post(artifact, "One.");
  await comments.edit({ ...place(artifact), commentId: root.id, body: "One, edited." });
  await comments.resolve({ ...place(artifact), commentId: root.id });
  await comments.reopen({ ...place(artifact), commentId: root.id });
  await comments.remove({ ...place(artifact), commentId: root.id });
  expect(events.map((event) => ("change" in event ? event.change : event.type))).toEqual([
    "posted",
    "edited",
    "resolved",
    "reopened",
    "deleted",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      type: "artifact.comments.changed.v1",
      workspaceId: f.workspaceId,
      artifactId: artifact,
      commentIds: [root.id],
    });
});

test("an Agent's comment announces too", async () => {
  const artifact = await f.make("Agent live");
  const announced: ArtifactSignalEvent[] = [];
  await f.post(
    f.agents.reader,
    { operation: "comment", artifact, body: "An Agent too.", idempotencyKey: f.key() },
    { signals: { publish: async (_channel, event) => void announced.push(event) } },
  );
  expect(announced).toEqual([
    {
      type: "artifact.comments.changed.v1",
      workspaceId: f.workspaceId,
      artifactId: artifact,
      change: "posted",
      commentIds: [expect.any(String)],
    },
  ]);
});

test("threads are paged by their first comment, newest first, with all their replies", async () => {
  const artifact = await f.make("Paging");
  const roots: string[] = [];
  for (let index = 0; index < 23; index += 1) roots.push((await post(artifact, `T${index}`)).id);
  await post(artifact, "Reply to the oldest.", { replyTo: roots[0]! }, f.bob);
  const newest = await list(artifact);
  expect(newest.total).toBe(24);
  expect(newest.comments.map((comment) => comment.id)).toEqual(roots.slice(3));
  expect(newest.before).toBeString();
  const older = await list(artifact, f.alice, newest.before);
  expect(bodiesOf(older)).toEqual(["T0", "T1", "T2", "Reply to the oldest."]);
  expect(older.before).toBeUndefined();
  await expect(list(artifact, f.alice, "nonsense")).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

test("a deleted root that keeps replies cannot be resolved", async () => {
  const artifact = await f.make("Deleted root");
  const root = await post(artifact, "Root.");
  await post(artifact, "Reply.", { replyTo: root.id }, f.bob);
  await comments.remove({ ...place(artifact), commentId: root.id });
  const shown = await list(artifact);
  expect(shown.comments[0]).toMatchObject({ id: root.id, deleted: true, canResolve: false });
});

test("a comment shows its author's own face, also once they left; an Agent's read carries none", async () => {
  const artifact = await f.make("Faces");
  const preset = avatarPresets[1]!;
  await f.db.user.update({
    where: { id: f.bob },
    data: { avatarObjectKey: avatarPresetReference(preset.id), avatarContentType: null },
  });
  await f.post(f.agents.reader, {
    operation: "comment",
    artifact,
    body: "From the Agent.",
    idempotencyKey: f.key(),
  });
  await post(artifact, "From Bob.", {}, f.bob);
  const reader = await f.db.agent.findUniqueOrThrow({
    where: { id: f.agents.reader },
    select: { id: true, avatarMascot: true },
  });
  await f.db.workspaceMembership.deleteMany({
    where: { workspaceId: f.workspaceId, userId: f.bob },
  });
  try {
    const page = await list(artifact);
    expect(page.comments.map((comment) => [comment.authorId, comment.authorAvatarUrl])).toEqual([
      [f.agents.reader, agentFaceUrl(reader)],
      [f.bob, preset.url],
    ]);
    const read = await f.post(f.agents.reader, { operation: "comments", artifact, all: true });
    expect(read.body.comments[0]).not.toHaveProperty("authorAvatarUrl");
  } finally {
    await f.db.workspaceMembership.create({
      data: { workspaceId: f.workspaceId, userId: f.bob, role: "member" },
    });
  }
});
