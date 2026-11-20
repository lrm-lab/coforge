import { afterAll, beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import { ARTIFACT_BLOB_GRACE_MS } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import type { CommentsFixture } from "./helpers/artifact-comments-fixture";
import { personCommentsHarness } from "./helpers/person-comments-harness";

let f: CommentsFixture;
let comments: ArtifactPersonComments;
const h = personCommentsHarness("pci", (ready) => {
  f = ready.f;
  comments = ready.comments;
});
beforeAll(h.setUp);
afterAll(h.tearDown);
const { place, draft, post, list, pngOf } = h;

test("a person's images are stored cleaned, limited to four, and only their own uploads count", async () => {
  const artifact = await f.make("Pictures");
  const upload = async (shade: number, userId = f.alice) =>
    (await comments.uploadImage({ ...place(artifact, userId), bytes: await pngOf(shade) })).sha256;
  const [one, two] = [await upload(10), await upload(20)];
  const { id } = await post(artifact, "See these.", { images: [one, two] });
  const stored = await f.db.artifactCommentImage.findMany({
    where: { commentId: id },
    orderBy: { position: "asc" },
  });
  expect(stored.map((image) => [image.position, image.contentType, image.width])).toEqual([
    [0, "image/png", 8],
    [1, "image/png", 8],
  ]);
  const shown = (await list(artifact)).comments[0] as { images: { id: string }[] };
  const bytes = await comments.readImage({
    ...place(artifact, f.bob),
    imageId: shown.images[0]!.id,
  });
  expect(bytes.contentType).toBe("image/png");
  expect(bytes.bytes.length).toBeGreaterThan(0);
  const five = await Promise.all([1, 2, 3, 4, 5].map((shade) => upload(shade * 30)));
  expect(() => draft("Too many.", { images: five })).toThrow();
  const bobs = await upload(99, f.bob);
  await expect(post(artifact, "Not yours.", { images: [bobs] })).rejects.toMatchObject({
    errorId: "artifact-image-not-found",
  });
  await expect(
    comments.uploadImage({ ...place(artifact), bytes: new Uint8Array(11 * 1024 * 1024) }),
  ).rejects.toMatchObject({ errorId: "artifact-image-too-large" });
});

test("deleting a comment removes its images", async () => {
  const artifact = await f.make("Image gone");
  const { sha256 } = await comments.uploadImage({
    ...place(artifact),
    bytes: await pngOf(70),
  });
  const { id } = await post(artifact, "Look.", { images: [sha256] });
  expect(await f.db.artifactCommentImage.count({ where: { commentId: id } })).toBe(1);
  await comments.remove({ ...place(artifact), commentId: id });
  expect(await f.db.artifactCommentImage.count({ where: { commentId: id } })).toBe(0);
});

const withCounted = (counts: { uploads: number }) =>
  new Proxy(f.blobs, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "upload") counts.uploads += 1;
        return value.apply(target, args);
      };
    },
  });

test("deleting blanks the row in the database: no anchor, no path unless replies keep the thread, its images released to the sweep", async () => {
  const artifact = await f.make("Blank on delete");
  const anchor = { type: "lines", data: { start: 1, end: 2 } };
  const upload = async (shade: number) =>
    (await comments.uploadImage({ ...place(artifact), bytes: await pngOf(shade) })).sha256;
  const [shared, own] = [await upload(111), await upload(112)];
  const lonely = await post(artifact, "Alone.", { path: "plan.md", anchor, images: [own, shared] });
  const parent = await post(artifact, "Has replies.", { path: "plan.md", anchor });
  await post(artifact, "A reply.", { replyTo: parent.id }, f.bob);
  const keeper = await post(artifact, "Keeps the shared image.", { images: [shared] });
  await comments.remove({ ...place(artifact), commentId: lonely.id });
  await comments.remove({ ...place(artifact), commentId: parent.id });
  const rows = await f.db.$queryRaw<{ id: string; anchor: unknown; path: string | null }[]>`
    SELECT "id", "anchor", "path" FROM "artifact_comments" WHERE "id" IN (${lonely.id}::uuid, ${parent.id}::uuid)`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  expect(byId.get(lonely.id)).toMatchObject({ anchor: null, path: null });
  expect(byId.get(parent.id)).toMatchObject({ anchor: null, path: "plan.md" });
  const blob = (sha256: string) =>
    f.db.artifactBlob.findUniqueOrThrow({
      where: { workspaceId_sha256: { workspaceId: f.workspaceId, sha256 } },
    });
  expect((await blob(own)).referenced).toBe(false);
  expect((await blob(shared)).referenced).toBe(true);
  await f.blobs.removeUnreferenced(new Date(Date.now() + ARTIFACT_BLOB_GRACE_MS + 60_000));
  expect(
    await f.db.artifactBlob.count({ where: { workspaceId: f.workspaceId, sha256: own } }),
  ).toBe(0);
  expect(
    await f.db.artifactBlob.count({ where: { workspaceId: f.workspaceId, sha256: shared } }),
  ).toBe(1);
  await comments.remove({ ...place(artifact), commentId: keeper.id });
  expect((await blob(shared)).referenced).toBe(false);
});

test("a delete racing a post that attaches the same image leaves the image counted as named", async () => {
  const artifact = await f.make("Release race");
  const shared = (await comments.uploadImage({ ...place(artifact), bytes: await pngOf(131) }))
    .sha256;
  const doomed = await post(artifact, "Goes away.", { images: [shared] });
  const other = await post(artifact, "Gains the image.");
  const image = await f.db.artifactCommentImage.findFirstOrThrow({
    where: { commentId: doomed.id },
  });
  let attached!: () => void;
  const holding = new Promise<void>((resolve) => (attached = resolve));
  let commit!: () => void;
  const committing = new Promise<void>((resolve) => (commit = resolve));
  const posting = f.db.$transaction(async (tx) => {
    await f.blobs.use(tx, f.workspaceId, [shared]);
    await tx.artifactCommentImage.create({
      data: { ...image, id: undefined, commentId: other.id, createdAt: undefined },
    });
    attached();
    await committing;
  });
  await holding;
  const removing = comments.remove({ ...place(artifact), commentId: doomed.id });
  await Bun.sleep(200);
  commit();
  await Promise.all([posting, removing]);
  const blob = await f.db.artifactBlob.findUniqueOrThrow({
    where: { workspaceId_sha256: { workspaceId: f.workspaceId, sha256: shared } },
  });
  expect(blob.referenced).toBe(true);
});

test("an upload is cleaned once: only the clean bytes are stored, and posting stores nothing again", async () => {
  const artifact = await f.make("Clean once");
  const dirty = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } },
  })
    .jpeg()
    .withExif({ IFD0: { Copyright: "secret-copyright" } })
    .toBuffer();
  const rawSha = new Bun.CryptoHasher("sha256").update(dirty).digest("hex");
  const { sha256 } = await comments.uploadImage({
    ...place(artifact),
    bytes: new Uint8Array(dirty) as Uint8Array<ArrayBuffer>,
  });
  expect(sha256).not.toBe(rawSha);
  expect(
    await f.db.artifactBlob.count({ where: { workspaceId: f.workspaceId, sha256: rawSha } }),
  ).toBe(0);
  const stored = await f.blobs.read(f.workspaceId, sha256);
  expect((await sharp(Buffer.from(stored!)).metadata()).exif).toBeUndefined();
  const counts = { uploads: 0 };
  const counting = new ArtifactPersonComments(f.db, withCounted(counts), f.notices);
  await counting.post({ ...place(artifact), comment: draft("Clean.", { images: [sha256] }) });
  expect(counts.uploads).toBe(0);
  const [image] = await f.db.artifactCommentImage.findMany({ where: { artifactId: artifact } });
  expect(image).toMatchObject({ sha256, contentType: "image/jpeg", width: 8, height: 8 });
});
