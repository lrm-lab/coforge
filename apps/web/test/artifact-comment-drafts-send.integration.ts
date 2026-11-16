import { afterAll, beforeAll, expect, test } from "bun:test";
import { lockDrafts } from "#src/server/artifacts/artifact-comment-draft-rows.server";
import { lockComments } from "#src/server/artifacts/artifact-comment-write.server";
import { draftsHarness, lines, type DraftsHarness } from "./helpers/artifact-drafts-harness";

let h: DraftsHarness;

beforeAll(async () => {
  h = await draftsHarness("cs");
});
afterAll(() => h.f.cleanup());

test("sending writes every draft as one review in the order they were saved, and tells each Agent once", async () => {
  const artifact = await h.f.make("Draft send");
  const parent = await h.f.personComments(artifact, h.f.bob, {
    body: "A question.",
    path: "plan.md",
  });
  const reader = await h.nameOf(h.f.agents.reader);
  const sha256 = await h.upload(artifact, 71);
  await h.create(artifact, `First, @${reader}.`);
  await h.create(artifact, "Whole artifact.", {
    path: undefined,
    anchor: undefined,
    images: [sha256],
  });
  await h.create(artifact, `An answer, @${reader}.`, {
    path: undefined,
    anchor: undefined,
    replyTo: parent.id,
  });
  const ids = await h.idsOf(artifact);
  const key = h.f.key();
  h.events.length = 0;
  const sent = await h.drafts.submit({ ...h.place(artifact), draftIds: ids, clientKey: key });
  if (sent.status !== "sent") throw new Error("not sent");
  expect(sent.commentIds).toHaveLength(3);
  const review = await h.f.db.artifactCommentReview.findUniqueOrThrow({
    where: { id: sent.reviewId },
  });
  expect(review).toMatchObject({
    authorUserId: h.f.alice,
    authorAgentId: null,
    body: null,
    version: 1,
  });
  const rows = await h.f.db.artifactComment.findMany({
    where: { reviewId: review.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  expect(rows.map((row) => row.body)).toEqual([
    `First, @${reader}.`,
    "Whole artifact.",
    `An answer, @${reader}.`,
  ]);
  expect(rows.map((row) => row.id)).toEqual(sent.commentIds);
  expect(rows.every((row) => row.authorUserId === h.f.alice)).toBe(true);
  expect(rows[0]).toMatchObject({ path: "plan.md", anchor: lines });
  expect(rows[2]).toMatchObject({ rootId: parent.id, path: "plan.md" });
  expect(await h.f.db.artifactCommentImage.count({ where: { commentId: rows[1]!.id } })).toBe(1);
  expect(await h.idsOf(artifact)).toEqual([]);
  expect(await h.f.db.artifactCommentDraft.count({ where: { artifactId: artifact } })).toBe(0);
  expect((await h.blobOf(sha256)).referenced).toBe(true);
  expect(h.events.filter((event) => event.type.includes("comments"))).toHaveLength(1);

  const aboutIt = async (agentId: string) =>
    (await h.f.noticesOf(agentId)).filter((notice) => notice.externalEventId.startsWith(artifact));
  expect(await aboutIt(h.f.agents.reader)).toHaveLength(1);
  expect(await aboutIt(h.f.agents.writer)).toHaveLength(1);
  expect(await aboutIt(h.f.agents.other)).toHaveLength(0);

  const again = await h.drafts.submit({ ...h.place(artifact), draftIds: ids, clientKey: key });
  expect(again).toMatchObject({
    status: "sent",
    reviewId: sent.reviewId,
    commentIds: sent.commentIds,
  });
  expect(await h.f.db.artifactComment.count({ where: { reviewId: review.id } })).toBe(3);
  expect(await aboutIt(h.f.agents.reader)).toHaveLength(1);
  await expect(
    h.drafts.submit({ ...h.place(artifact), draftIds: [ids[0]!], clientKey: key }),
  ).rejects.toMatchObject({ errorId: "artifact-idempotency-mismatch" });
});

test("sending refuses when the drafts on screen are not the person's drafts", async () => {
  const artifact = await h.f.make("Draft changed");
  const one = await h.create(artifact, "One.");
  const two = await h.create(artifact, "Two.");
  await expect(
    h.drafts.submit({ ...h.place(artifact), draftIds: [one.id], clientKey: h.f.key() }),
  ).rejects.toMatchObject({ errorId: "artifact-drafts-changed" });
  await expect(
    h.drafts.submit({
      ...h.place(artifact),
      draftIds: [one.id, two.id, crypto.randomUUID()],
      clientKey: h.f.key(),
    }),
  ).rejects.toMatchObject({ errorId: "artifact-drafts-changed" });
  await expect(
    h.drafts.submit({
      ...h.place(artifact, h.f.bob),
      draftIds: [one.id, two.id],
      clientKey: h.f.key(),
    }),
  ).rejects.toMatchObject({ errorId: "artifact-drafts-changed" });
  expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await h.idsOf(artifact)).toEqual([one.id, two.id]);
});

test("a refused send writes nothing and names the first draft that cannot be sent, with why", async () => {
  const artifact = await h.f.make("Draft refused", undefined, { target: `#${h.f.privateChannel}` });
  const bob = await h.f.db.user.findUniqueOrThrow({ where: { id: h.f.bob } });
  const good = await h.create(artifact, "Fine.");
  const refused = async (reason: string, draftId: string) => {
    const result = await h.submit(artifact);
    expect(result).toMatchObject({ status: "rejected", draftId, reason });
    expect(
      await h.f.db.artifactComment.count({
        where: { artifactId: artifact, reviewId: { not: null } },
      }),
    ).toBe(0);
    expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
    expect(await h.idsOf(artifact)).toContain(draftId);
  };

  const mention = await h.create(artifact, `Look @${bob.username}`);
  await refused("mention-cannot-see", mention.id);
  await h.drafts.edit({ ...h.place(artifact), draftId: mention.id, body: "No mention." });

  const path = await h.create(artifact, "Gone file.");
  await h.f.db.artifactCommentDraft.update({ where: { id: path.id }, data: { path: "gone.md" } });
  await refused("file-gone", path.id);
  await h.drafts.remove({ ...h.place(artifact), draftId: path.id });

  const version = await h.create(artifact, "Gone version.");
  await h.f.db.artifactCommentDraft.update({ where: { id: version.id }, data: { version: 9 } });
  await refused("version-gone", version.id);
  await h.drafts.remove({ ...h.place(artifact), draftId: version.id });

  const parent = await h.f.personComments(artifact, h.f.alice, {
    body: "To be deleted.",
    path: "plan.md",
  });
  const reply = await h.create(artifact, "A reply.", {
    path: undefined,
    anchor: undefined,
    replyTo: parent.id,
  });
  await h.comments.remove({ ...h.place(artifact), commentId: parent.id });
  await refused("reply-gone", reply.id);
  await h.drafts.remove({ ...h.place(artifact), draftId: reply.id });

  const handle = crypto.randomUUID().slice(0, 8);
  const names = Array.from({ length: 11 }, (_, index) => `crowd-${index}-${handle}`);
  await h.f.db.agent.createMany({
    data: names.map((name) => ({
      workspaceId: h.f.workspaceId,
      name,
      displayName: name,
      ownerId: h.f.alice,
      runtimeConfig: {},
    })),
  });
  try {
    const crowd = await h.create(artifact, names.map((name) => `@${name}`).join(" "));
    await refused("too-many-mentions", crowd.id);
    await h.drafts.remove({ ...h.place(artifact), draftId: crowd.id });
  } finally {
    await h.f.db.agent.deleteMany({ where: { name: { in: names } } });
  }

  const sent = await h.submit(artifact);
  expect(sent).toMatchObject({ status: "sent" });
  expect(good.id).toBeString();
});

test("the first draft in creation order that cannot be sent is named, whichever check finds it", async () => {
  const artifact = await h.f.make("Draft refusal order", undefined, {
    target: `#${h.f.privateChannel}`,
  });
  const bob = await h.f.db.user.findUniqueOrThrow({ where: { id: h.f.bob } });
  const gone = await h.create(artifact, "Gone file.");
  await h.f.db.artifactCommentDraft.update({ where: { id: gone.id }, data: { path: "gone.md" } });
  const mention = await h.create(artifact, `Look @${bob.username}`);
  expect(await h.submit(artifact)).toMatchObject({
    status: "rejected",
    draftId: gone.id,
    reason: "file-gone",
  });
  await h.drafts.remove({ ...h.place(artifact), draftId: gone.id });
  const later = await h.create(artifact, "Gone file again.");
  await h.f.db.artifactCommentDraft.update({ where: { id: later.id }, data: { path: "gone.md" } });
  expect(await h.submit(artifact)).toMatchObject({
    status: "rejected",
    draftId: mention.id,
    reason: "mention-cannot-see",
    names: [bob.username],
  });
  expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
});

test("a draft's mentions are checked on their own, however many handles another draft names", async () => {
  const artifact = await h.f.make("Draft crowded handles", undefined, {
    target: `#${h.f.privateChannel}`,
  });
  const bob = await h.f.db.user.findUniqueOrThrow({ where: { id: h.f.bob } });
  const handle = crypto.randomUUID().slice(0, 8);
  await h.create(
    artifact,
    Array.from({ length: 120 }, (_, index) => `@nobody-${index}-${handle}`).join(" "),
  );
  const mention = await h.create(artifact, `Look @${bob.username}`);
  expect(await h.submit(artifact)).toMatchObject({
    status: "rejected",
    draftId: mention.id,
    reason: "mention-cannot-see",
    names: [bob.username],
  });
});

test("two sends with different keys write one review; the other finds the drafts gone", async () => {
  const artifact = await h.f.make("Draft double send");
  await h.create(artifact, "One.");
  await h.create(artifact, "Two.");
  const draftIds = await h.idsOf(artifact);
  const attempts = await Promise.allSettled(
    [h.f.key(), h.f.key()].map((clientKey) =>
      h.drafts.submit({ ...h.place(artifact), draftIds, clientKey }),
    ),
  );
  const sent = attempts.filter((attempt) => attempt.status === "fulfilled");
  const refused = attempts.filter((attempt) => attempt.status === "rejected");
  expect(sent).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]!.reason).toMatchObject({ errorId: "artifact-drafts-changed" });
  expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(1);
  expect(await h.f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(2);
});

async function holding(
  lock: (tx: Parameters<typeof lockDrafts>[0]) => Promise<unknown>,
  waiters: () => Promise<unknown>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const acquired = new Promise<void>((resolve) => (held = resolve));
  const holder = h.f.db.$transaction(async (tx) => {
    await lock(tx);
    held();
    await released;
  });
  await acquired;
  await waiters();
  release();
  await holder;
}

test("a send racing a draft delete writes every draft or none", async () => {
  const artifact = await h.f.make("Draft send and delete");
  await h.create(artifact, "One.");
  const doomed = await h.create(artifact, "Two.");
  await h.create(artifact, "Three.");
  const draftIds = await h.idsOf(artifact);
  let sending!: ReturnType<typeof h.drafts.submit>;
  let deleting!: ReturnType<typeof h.drafts.remove>;
  await holding(
    (tx) => lockDrafts(tx, artifact, h.f.alice),
    async () => {
      sending = h.drafts.submit({ ...h.place(artifact), draftIds, clientKey: h.f.key() });
      deleting = h.drafts.remove({ ...h.place(artifact), draftId: doomed.id });
      sending.catch(() => undefined);
      await h.waitForBlockedStatement("%pg_advisory_xact_lock%", 2);
    },
  );
  const [send, removal] = await Promise.allSettled([sending, deleting]);
  const reviews = await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } });
  const written = await h.f.db.artifactComment.count({ where: { artifactId: artifact } });
  if (send.status === "fulfilled") {
    expect(send.value).toMatchObject({ status: "sent" });
    expect([reviews, written]).toEqual([1, 3]);
    expect(await h.idsOf(artifact)).toEqual([]);
  } else {
    expect(send.reason).toMatchObject({ errorId: "artifact-drafts-changed" });
    expect(removal).toMatchObject({ status: "fulfilled", value: { removed: true } });
    expect([reviews, written]).toEqual([0, 0]);
    expect(await h.idsOf(artifact)).toHaveLength(2);
  }
});

test("a send racing the deletion of a reply's target writes every draft or none", async () => {
  const artifact = await h.f.make("Draft send and target");
  const parent = await h.f.personComments(artifact, h.f.alice, {
    body: "To be deleted.",
    path: "plan.md",
  });
  await h.create(artifact, "Plain.");
  await h.create(artifact, "A reply.", { path: undefined, anchor: undefined, replyTo: parent.id });
  const draftIds = await h.idsOf(artifact);
  const before = await h.f.db.artifactComment.count({ where: { artifactId: artifact } });
  let sending!: ReturnType<typeof h.drafts.submit>;
  let removing!: ReturnType<typeof h.comments.remove>;
  await holding(
    (tx) => lockComments(tx, artifact),
    async () => {
      sending = h.drafts.submit({ ...h.place(artifact), draftIds, clientKey: h.f.key() });
      removing = h.comments.remove({ ...h.place(artifact), commentId: parent.id });
      await h.waitForBlockedStatement("%pg_advisory_xact_lock%", 2);
    },
  );
  const [send] = await Promise.all([sending, removing]);
  const written = await h.f.db.artifactComment.count({
    where: { artifactId: artifact, reviewId: { not: null } },
  });
  if (send.status === "sent") {
    expect(written).toBe(2);
    expect(await h.idsOf(artifact)).toEqual([]);
  } else {
    expect(send).toMatchObject({ status: "rejected", reason: "reply-gone" });
    expect(written).toBe(0);
    expect(await h.idsOf(artifact)).toEqual(draftIds);
  }
  expect(before).toBe(1);
});

test("a review's comments are read by its id, for an Agent's review and a person's, on its own artifact only", async () => {
  const artifact = await h.f.make("Review read");
  const other = await h.f.make("Other artifact");
  await h.create(artifact, "From a person.");
  await h.create(artifact, "And a second.", { path: undefined, anchor: undefined });
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const read = await h.comments.review({ ...h.place(artifact, h.f.bob), reviewId: sent.reviewId });
  expect(read.review).toMatchObject({ id: sent.reviewId, version: 1, body: null });
  expect(read.review?.author.name).toBe("Alice");
  expect(read.comments.map((comment) => comment.id)).toEqual(sent.commentIds);
  expect(read.comments.every((comment) => !comment.mine)).toBe(true);
  expect(await h.comments.review({ ...h.place(other), reviewId: sent.reviewId })).toEqual({
    review: null,
    comments: [],
  });
  await h.f.post(h.f.agents.reader, { operation: "comments", artifact });
  const agentReview = await h.f.post(h.f.agents.reader, {
    operation: "review",
    artifact,
    idempotencyKey: h.f.key(),
    comments: [{ body: "Agent note." }],
  });
  const agents = await h.comments.review({
    ...h.place(artifact),
    reviewId: agentReview.body.review.id,
  });
  expect(agents.comments.map((comment) => ("deleted" in comment ? "" : comment.body))).toEqual([
    "Agent note.",
  ]);
});
