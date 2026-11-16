import { afterAll, beforeAll, expect, test } from "bun:test";
import { COMMENT_DRAFTS_MAX } from "#src/features/artifacts/artifact-comment-draft-inputs";
import { ARTIFACT_BLOB_GRACE_MS } from "#src/server/artifacts/artifact-blobs.server";
import { draftsHarness, lines, type DraftsHarness } from "./helpers/artifact-drafts-harness";

let h: DraftsHarness;

beforeAll(async () => {
  h = await draftsHarness("cd");
});
afterAll(() => h.f.cleanup());

test("a person's drafts are listed oldest first, edited, deleted and discarded, and nobody else reads them", async () => {
  const artifact = await h.f.make("Draft CRUD");
  const first = await h.create(artifact, "First.");
  const second = await h.create(artifact, "Second.");
  const third = await h.create(artifact, "Third.", { path: undefined, anchor: undefined });
  const listed = await h.drafts.list(h.place(artifact));
  expect(listed.drafts.map((draft) => draft.body)).toEqual(["First.", "Second.", "Third."]);
  expect(listed.limit).toBe(COMMENT_DRAFTS_MAX);
  expect(listed.drafts[0]).toMatchObject({ version: 1, path: "plan.md", anchor: lines });
  expect(listed.drafts[2]).toMatchObject({ path: null, anchor: null, replyTo: null });

  expect((await h.drafts.list(h.place(artifact, h.f.bob))).drafts).toEqual([]);
  await expect(
    h.drafts.edit({ ...h.place(artifact, h.f.bob), draftId: first.id, body: "Mine now." }),
  ).rejects.toMatchObject({ errorId: "artifact-draft-not-found" });
  expect(await h.drafts.remove({ ...h.place(artifact, h.f.bob), draftId: first.id })).toEqual({
    removed: false,
  });
  expect(await h.idsOf(artifact)).toHaveLength(3);
  const agentRead = await h.f.post(h.f.agents.reader, {
    operation: "comments",
    artifact,
    all: true,
  });
  expect(agentRead.body.comments).toEqual([]);
  expect(await h.f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);

  await h.f.db.artifactCommentDraft.update({
    where: { id: second.id },
    data: { expiresAt: new Date(Date.now() + 60_000) },
  });
  const edited = await h.drafts.edit({
    ...h.place(artifact),
    draftId: second.id,
    body: "Second, again.",
  });
  expect(edited.body).toBe("Second, again.");
  expect(edited.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  await expect(
    h.drafts.edit({ ...h.place(artifact), draftId: second.id, body: "" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  expect(await h.drafts.remove({ ...h.place(artifact), draftId: third.id })).toEqual({
    removed: true,
  });
  expect(await h.drafts.remove({ ...h.place(artifact), draftId: third.id })).toEqual({
    removed: false,
  });
  expect(await h.drafts.discardAll(h.place(artifact))).toEqual({ removed: 2 });
  expect(await h.idsOf(artifact)).toEqual([]);
});

test("a draft is checked against the artifact when it is saved", async () => {
  const artifact = await h.f.make("Draft checks");
  await expect(h.create(artifact, "No file.", { path: "missing.md" })).rejects.toMatchObject({
    errorId: "artifact-comment-path",
  });
  await expect(h.create(artifact, "Future.", { version: 9 })).rejects.toMatchObject({
    errorId: "artifact-comment-version",
  });
  await expect(
    h.create(artifact, "No parent.", {
      path: undefined,
      anchor: undefined,
      replyTo: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ errorId: "artifact-comment-not-found" });
  await expect(h.create(artifact, "Floating anchor.", { path: undefined })).rejects.toMatchObject({
    errorId: "artifact-comment-anchor",
  });
  expect(await h.idsOf(artifact)).toEqual([]);
});

test("a person holds at most fifty drafts on an artifact", async () => {
  const artifact = await h.f.make("Draft cap");
  const base = { artifactId: artifact, userId: h.f.alice, version: 1, body: "x" };
  await h.f.db.artifactCommentDraft.createMany({
    data: Array.from({ length: COMMENT_DRAFTS_MAX - 1 }, (_, index) => ({
      ...base,
      body: `Draft ${index}`,
      expiresAt: new Date(Date.now() + 3600_000),
    })),
  });
  await h.create(artifact, "The fiftieth.");
  await expect(h.create(artifact, "The fifty-first.")).rejects.toMatchObject({
    errorId: "artifact-draft-limit",
    details: { limit: COMMENT_DRAFTS_MAX },
  });
  expect((await h.create(artifact, "Bob has his own.", {}, h.f.bob)).body).toBe("Bob has his own.");
});

test("concurrent saves cannot pass the cap", async () => {
  const artifact = await h.f.make("Draft cap race");
  await h.f.db.artifactCommentDraft.createMany({
    data: Array.from({ length: COMMENT_DRAFTS_MAX - 1 }, (_, index) => ({
      artifactId: artifact,
      userId: h.f.alice,
      version: 1,
      body: `Draft ${index}`,
      expiresAt: new Date(Date.now() + 3600_000),
    })),
  });
  const attempts = await Promise.allSettled([h.create(artifact, "A."), h.create(artifact, "B.")]);
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  expect(await h.f.db.artifactCommentDraft.count({ where: { artifactId: artifact } })).toBe(
    COMMENT_DRAFTS_MAX,
  );
});

test("an expired draft is hidden, never sent, and swept with its image released", async () => {
  const artifact = await h.f.make("Draft expiry");
  const sha256 = await h.upload(artifact, 41);
  const stale = await h.create(artifact, "Stale.", { images: [sha256] });
  const fresh = await h.create(artifact, "Fresh.");
  const past = new Date(Date.now() - 1000);
  await h.f.db.artifactCommentDraft.update({ where: { id: stale.id }, data: { expiresAt: past } });
  expect(await h.idsOf(artifact)).toEqual([fresh.id]);
  await expect(
    h.drafts.submit({ ...h.place(artifact), draftIds: [stale.id, fresh.id], clientKey: h.f.key() }),
  ).rejects.toMatchObject({ errorId: "artifact-drafts-changed" });
  expect(await h.drafts.sweepExpired()).toBe(1);
  expect(await h.f.db.artifactCommentDraft.count({ where: { artifactId: artifact } })).toBe(1);
  expect((await h.blobOf(sha256)).referenced).toBe(false);
  expect(await h.f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);
});

test("a draft's image keeps its blob from the sweep, and releasing the draft lets it go", async () => {
  const artifact = await h.f.make("Draft image");
  const sha256 = await h.upload(artifact, 51);
  const held = await h.create(artifact, "Look.", { images: [sha256] });
  expect(held.images).toEqual([
    { position: 0, contentType: "image/png", sizeBytes: expect.any(Number), width: 8, height: 8 },
  ]);
  expect((await h.blobOf(sha256)).referenced).toBe(true);
  await h.f.db.artifactBlob.updateMany({
    where: { workspaceId: h.f.workspaceId, sha256 },
    data: { referenced: false, lastUsedAt: new Date(0) },
  });
  const later = new Date(Date.now() + ARTIFACT_BLOB_GRACE_MS + 60_000);
  await h.f.blobs.removeUnreferenced(later);
  expect(await h.f.db.artifactBlob.count({ where: { workspaceId: h.f.workspaceId, sha256 } })).toBe(
    1,
  );
  const bytes = await h.drafts.readImage({ ...h.place(artifact), draftId: held.id, position: 0 });
  expect(bytes.contentType).toBe("image/png");
  await expect(
    h.drafts.readImage({ ...h.place(artifact, h.f.bob), draftId: held.id, position: 0 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await h.drafts.remove({ ...h.place(artifact), draftId: held.id });
  expect((await h.blobOf(sha256)).referenced).toBe(false);
  await h.f.blobs.removeUnreferenced(later);
  expect(await h.f.db.artifactBlob.count({ where: { workspaceId: h.f.workspaceId, sha256 } })).toBe(
    0,
  );
});

test("a delete racing a draft that attaches the same image leaves the image counted as named", async () => {
  const artifact = await h.f.make("Draft release race");
  const shared = await h.upload(artifact, 61);
  const doomed = await h.create(artifact, "Goes away.", { images: [shared] });
  const image = doomed.images[0]!;
  let attached!: () => void;
  const holding = new Promise<void>((resolve) => (attached = resolve));
  let commit!: () => void;
  const committing = new Promise<void>((resolve) => (commit = resolve));
  const attaching = h.f.db.$transaction(async (tx) => {
    await h.f.blobs.use(tx, h.f.workspaceId, [shared]);
    await tx.artifactCommentDraft.create({
      data: {
        artifactId: artifact,
        userId: h.f.bob,
        version: 1,
        body: "Gains the image.",
        images: [{ sha256: shared, ...image }],
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    attached();
    await committing;
  });
  await holding;
  const removing = h.drafts.remove({ ...h.place(artifact), draftId: doomed.id });
  await h.waitForBlockedStatement("%artifact_blobs%");
  commit();
  await Promise.all([attaching, removing]);
  expect((await h.blobOf(shared)).referenced).toBe(true);
});

test("a restored draft takes its old place in creation order, within the draft window", async () => {
  const artifact = await h.f.make("Draft restore");
  await h.create(artifact, "First.");
  const second = await h.create(artifact, "Second.");
  await h.create(artifact, "Third.");
  await h.drafts.remove({ ...h.place(artifact), draftId: second.id });
  const restored = await h.create(artifact, "Second.", { createdAt: second.createdAt });
  expect(restored.createdAt).toEqual(second.createdAt);
  expect(restored.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  const bodies = async () =>
    (await h.drafts.list(h.place(artifact))).drafts.map((draft) => draft.body);
  expect(await bodies()).toEqual(["First.", "Second.", "Third."]);

  const before = Date.now();
  const future = await h.create(artifact, "Future.", { createdAt: new Date(before + 3_600_000) });
  expect(future.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  const ancient = await h.create(artifact, "Ancient.", { createdAt: new Date(0) });
  expect(ancient.createdAt.getTime()).toBeGreaterThanOrEqual(before - 30 * 24 * 3600 * 1000);
  expect(await bodies()).toEqual(["Ancient.", "First.", "Second.", "Third.", "Future."]);

  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const rows = await h.f.db.artifactComment.findMany({
    where: { reviewId: sent.reviewId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  expect(rows.map((row) => row.body)).toEqual([
    "Ancient.",
    "First.",
    "Second.",
    "Third.",
    "Future.",
  ]);
});

test("the blob reference check reads the drafts through a GIN index on their images", async () => {
  const [row] = await h.f.db.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'artifact_comment_drafts' AND indexdef LIKE '%gin%'`;
  expect(row?.indexdef).toContain("gin (images jsonb_path_ops)");
});
