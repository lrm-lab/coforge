import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("ref");
});
afterAll(() => f.cleanup());

const read = (agentId: string, artifact: string, extra: object = {}) =>
  f.post(agentId, { operation: "read", artifact, ...extra });

test("an artifact is named by id, by its web link with a version, or by its exact title", async () => {
  const id = await f.make("Reference Title One", { "plan.md": "v1\n" });
  await f.pushText(id, f.agents.writer, "v2\n");
  const byId = await read(f.agents.reader, id);
  expect(byId.body.text).toBe("v2\n");
  const byTitle = await read(f.agents.reader, "Reference Title One");
  expect(byTitle.body.text).toBe("v2\n");
  const link = await read(
    f.agents.reader,
    `https://coforge.example/w/ws/artifacts/${id}?version=1`,
  );
  expect(link.body.text).toBe("v1\n");
  const explicit = await read(f.agents.reader, `/w/ws/artifacts/${id}?v=1`, { version: 2 });
  expect(explicit.body.text).toBe("v2\n");
  expect((await read(f.agents.reader, "No such title")).status).toBe(404);
  const foreign = await read(f.agents.reader, "https://elsewhere.example/page");
  expect(foreign.status).toBe(400);
  expect(foreign.body.error).toContain("artifact-reference");
});

test("a title shared by several artifacts is a conflict naming their ids", async () => {
  const one = await f.make("Reference Twin");
  const two = await f.make("Reference Twin");
  const answer = await read(f.agents.reader, "Reference Twin");
  expect(answer.status).toBe(409);
  expect(answer.body.error).toContain("artifact-ambiguous-title");
  expect((answer.body.details.candidates as string).split(",").sort()).toEqual([one, two].sort());
});

test("a push equal to its base makes no version, a title-only push renames, an identical retry replays", async () => {
  const id = await f.make("Semantics");
  const same = await f.post(f.agents.reader, {
    operation: "push",
    artifact: id,
    baseVersion: 1,
    idempotencyKey: f.key(),
    files: await f.manifestOf(f.agents.reader, { "plan.md": "one\ntwo\nthree\n" }),
  });
  expect(same.body).toMatchObject({ status: "nothing", unchanged: true });
  const renameKey = f.key();
  const rename = {
    operation: "push",
    artifact: id,
    baseVersion: 1,
    idempotencyKey: renameKey,
    title: "Semantics 2",
  };
  const renamed = await f.post(f.agents.reader, rename);
  expect(renamed.body).toMatchObject({
    status: "nothing",
    unchanged: true,
    titleChanged: { from: "Semantics" },
  });
  const pushKey = f.key();
  const push = {
    operation: "push",
    artifact: id,
    baseVersion: 1,
    idempotencyKey: pushKey,
    files: await f.manifestOf(f.agents.reader, { "plan.md": "changed\n" }),
  };
  expect((await f.post(f.agents.reader, push)).body.status).toBe("created");
  const replay = await f.post(f.agents.reader, push);
  expect(replay.body).toMatchObject({ status: "replayed", replayed: true });
  const long = await f.post(f.agents.reader, {
    ...rename,
    idempotencyKey: f.key(),
    baseVersion: 2,
    title: "x".repeat(301),
  });
  expect(long.status).toBe(400);
  const max = await f.post(f.agents.reader, {
    ...rename,
    idempotencyKey: f.key(),
    baseVersion: 2,
    title: "y".repeat(300),
  });
  expect(max.body.titleChanged).toBeDefined();
});

test("artifact writes are limited per Agent, reads are not", async () => {
  const id = await f.make("Limited");
  let left = 2;
  const writeLimit = {
    admit: async () =>
      left-- > 0 ? { allowed: true as const } : { allowed: false as const, retryAfterSeconds: 17 },
  };
  const comment = () =>
    f.post(
      f.agents.reader,
      { operation: "comment", artifact: id, body: "hi", idempotencyKey: f.key() },
      { writeLimit } as never,
    );
  await f.post(f.agents.reader, { operation: "read", artifact: id });
  expect((await comment()).status).toBe(200);
  await f.post(f.agents.reader, { operation: "read", artifact: id }, { writeLimit } as never);
  expect((await comment()).status).toBe(200);
  const limited = await comment();
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  expect(limited.body.details.retryAfterSeconds).toBe(17);
  expect(
    (await f.post(f.agents.reader, { operation: "read", artifact: id }, { writeLimit } as never))
      .status,
  ).toBe(200);
});

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
) as Uint8Array<ArrayBuffer>;

async function upload(agentId: string, bytes: Uint8Array<ArrayBuffer>) {
  return (await f.blobs.upload({ workspaceId: f.workspaceId, bytes, actor: { agentId } })).sha256;
}

test("a comment carries uploaded images, the views list them, and download returns the bytes", async () => {
  const id = await f.make("Images");
  await read(f.agents.reader, id);
  const sha = await upload(f.agents.reader, PNG);
  const posted = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: [sha],
  });
  expect(posted.status).toBe(200);
  expect(posted.body.images).toEqual([
    {
      id: expect.any(String),
      contentType: "image/png",
      sizeBytes: expect.any(Number),
      width: 1,
      height: 1,
    },
  ]);
  const image = await f.post(f.agents.reader, {
    operation: "image",
    artifact: id,
    image: posted.body.images[0].id,
  });
  expect(image.body).toMatchObject({
    contentType: "image/png",
    sizeBytes: posted.body.images[0].sizeBytes,
  });
  expect(Buffer.from(image.body.data, "base64").length).toBe(posted.body.images[0].sizeBytes);
  await read(f.agents.writer, id);
  const listed = await f.post(f.agents.writer, { operation: "comments", artifact: id, all: true });
  expect(listed.body.comments[0].images).toHaveLength(1);
});

test("images are checked: signature, count and ownership of the upload", async () => {
  const id = await f.make("Image checks");
  await read(f.agents.reader, id);
  const text = await upload(
    f.agents.reader,
    new TextEncoder().encode("not an image") as Uint8Array<ArrayBuffer>,
  );
  const wrongType = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: [text],
  });
  expect(wrongType.status).toBe(400);
  expect(wrongType.body.error).toContain("artifact-image-type");
  const strangers = await f.post(f.agents.other, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: [await upload(f.agents.reader, PNG)],
  });
  expect(strangers.status).toBe(400);
  const missing = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: ["a".repeat(64)],
  });
  expect(missing.body.error).toContain("artifact-image-not-found");
  const tooMany = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: Array(5).fill(await upload(f.agents.reader, PNG)),
  });
  expect(tooMany.status).toBe(400);
  const empty = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
  });
  expect(empty.status).toBe(400);
});

test("an attachment is saved as an artifact once, homed in its message's conversation", async () => {
  const conversation = await f.db.conversation.findFirstOrThrow({
    where: { workspaceId: f.workspaceId, channelName: f.docsChannel },
  });
  const attachmentId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const attachments = {
    read: async (principal: { agentId: string }, wanted: string) =>
      wanted === attachmentId && principal.agentId !== f.agents.other
        ? {
            id: attachmentId,
            messageId,
            conversationId: conversation.id,
            fileName: "Notes: 1/2.md",
            sizeBytes: 3,
            bytes: async () => new TextEncoder().encode("# x") as Uint8Array<ArrayBuffer>,
          }
        : null,
  };
  const saved = await f.post(f.agents.reader, { operation: "save", attachment: attachmentId }, {
    attachments,
  } as never);
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({
    created: true,
    artifact: { title: "Notes: 1/2.md", entryPath: "Notes_ 1_2.md" },
  });
  const again = await f.post(f.agents.writer, { operation: "save", attachment: attachmentId }, {
    attachments,
  } as never);
  expect(again.body).toMatchObject({ created: false, artifact: { id: saved.body.artifact.id } });
  const row = await f.db.artifact.findUniqueOrThrow({ where: { id: saved.body.artifact.id } });
  expect(row).toMatchObject({ originMessageId: messageId, originAttachmentId: attachmentId });
  const unreadable = await f.post(f.agents.other, { operation: "save", attachment: attachmentId }, {
    attachments,
  } as never);
  expect(unreadable.status).toBe(404);
  expect(
    (
      await f.post(f.agents.reader, { operation: "save", attachment: "nope" }, {
        attachments,
      } as never)
    ).status,
  ).toBe(404);
});

test("an image comes back re-encoded without its metadata, and an undecodable one is refused", async () => {
  const sharp = (await import("sharp")).default;
  const withGps = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 0/1 0/1" } })
    .toBuffer();
  expect((await sharp(withGps).metadata()).exif).toBeDefined();
  const id = await f.make("Image strip");
  await read(f.agents.reader, id);
  const sha = await upload(f.agents.reader, new Uint8Array(withGps) as Uint8Array<ArrayBuffer>);
  const posted = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: [sha],
  });
  expect(posted.status).toBe(200);
  expect(posted.body.images[0]).toMatchObject({ contentType: "image/jpeg", width: 8, height: 4 });
  const got = await f.post(f.agents.reader, {
    operation: "image",
    artifact: id,
    image: posted.body.images[0].id,
  });
  const bytes = Buffer.from(got.body.data, "base64");
  const meta = await sharp(bytes).metadata();
  expect(meta.exif).toBeUndefined();
  expect(meta.width).toBe(8);
  expect(bytes.equals(Buffer.from(withGps))).toBe(false);
  const corrupt = new Uint8Array(withGps.subarray(0, 40)) as Uint8Array<ArrayBuffer>;
  const bad = await f.post(f.agents.reader, {
    operation: "comment",
    artifact: id,
    idempotencyKey: f.key(),
    images: [await upload(f.agents.reader, corrupt)],
  });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toContain("artifact-image-type");
});
