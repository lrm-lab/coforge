import { afterAll, beforeAll, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import {
  artifactDownload,
  artifactFilePreview,
} from "#src/server/artifacts/artifact-download.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

const unlimited = { admit: async () => ({ allowed: true as const }) };

let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("dl");
});
afterAll(() => f.cleanup());

const download = (
  artifactId: string,
  userId: string,
  extra: { path?: string; version?: number; limit?: number } = {},
) =>
  artifactDownload(
    { reads: f.artifacts.reads, blobs: f.blobs, zipLimit: unlimited },
    { workspaceId: f.workspaceId, artifactId, userId, ...extra },
  );

test("one file downloads as an attachment with its own bytes", async () => {
  const artifact = await f.make("Pair", { "plan.md": "# Plan\n", "data/a.csv": "x,y\n1,2\n" });
  const response = await download(artifact, f.bob, { path: "data/a.csv" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-disposition")).toContain("a.csv");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("x,y\n1,2\n");
});

test("a file of a named version is cached for good, the latest one is not cached", async () => {
  const artifact = await f.make("Cached", { "plan.md": "# Plan\n" });
  const pinned = await download(artifact, f.bob, { path: "plan.md", version: 1 });
  expect(pinned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  const latest = await download(artifact, f.bob, { path: "plan.md" });
  expect(latest.headers.get("cache-control")).toBe("private, no-store");
});

test("every file downloads as a zip named for the artifact, paths kept", async () => {
  const artifact = await f.make("Pair zip", { "plan.md": "# Plan\n", "data/a.csv": "x,y\n1,2\n" });
  const response = await download(artifact, f.bob);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toContain("Pair%20zip.zip");
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(Object.keys(entries).sort()).toEqual(["data/a.csv", "plan.md"]);
  expect(new TextDecoder().decode(entries["plan.md"])).toBe("# Plan\n");
});

test("a zip whose bytes have vanished is not found before any byte is sent", async () => {
  const artifact = await f.make("Vanished", { "plan.md": "# Plan\n", "a.txt": "a" });
  const lost = (
    await f.artifacts.reads.read({
      workspaceId: f.workspaceId,
      artifactId: artifact,
      reader: { userId: f.bob },
    })
  ).files[0]!.sha256;
  const blobs = {
    read: f.blobs.read.bind(f.blobs),
    inspectMany: async (workspaceId: string, sha256s: readonly string[]) =>
      f.blobs.inspectMany(
        workspaceId,
        sha256s.filter((sha256) => sha256 !== lost),
      ),
  };
  await expect(
    artifactDownload(
      { reads: f.artifacts.reads, blobs, zipLimit: unlimited },
      { workspaceId: f.workspaceId, artifactId: artifact, userId: f.bob },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a zip checks its blobs without reading them and streams each one in turn", async () => {
  const artifact = await f.make("Lazy", { "plan.md": "a", "b.txt": "b", "c.txt": "c" });
  let reads = 0;
  const blobs = {
    inspectMany: f.blobs.inspectMany.bind(f.blobs),
    read: async (workspaceId: string, sha256: string) => {
      reads++;
      return f.blobs.read(workspaceId, sha256);
    },
  };
  const response = await artifactDownload(
    { reads: f.artifacts.reads, blobs, zipLimit: unlimited },
    { workspaceId: f.workspaceId, artifactId: artifact, userId: f.bob },
  );
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(Object.keys(entries).sort()).toEqual(["b.txt", "c.txt", "plan.md"]);
  expect(reads).toBe(3);
});

test("zip entries are stored, not compressed", async () => {
  const artifact = await f.make("Stored", { "plan.md": "z".repeat(10_000) });
  const bytes = new Uint8Array(await (await download(artifact, f.bob)).arrayBuffer());
  expect(bytes.length).toBeGreaterThan(10_000);
});

test("a person's zip downloads are limited, single files are not", async () => {
  const artifact = await f.make("Limited", { "plan.md": "# Plan\n" });
  let admitted = 0;
  const zipLimit = {
    admit: async () =>
      ++admitted <= 2
        ? { allowed: true as const }
        : { allowed: false as const, retryAfterSeconds: 7 },
  };
  const limited = (path?: string) =>
    artifactDownload(
      { reads: f.artifacts.reads, blobs: f.blobs, zipLimit },
      { workspaceId: f.workspaceId, artifactId: artifact, userId: f.bob, path },
    );
  expect((await limited()).status).toBe(200);
  expect((await limited()).status).toBe(200);
  const refused = await limited();
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("7");
  expect((await limited("plan.md")).status).toBe(200);
});

test("a version too large to zip is refused with a pointer to one-by-one downloads", async () => {
  const artifact = await f.make("Large", { "plan.md": "0123456789" });
  await expect(download(artifact, f.bob, { limit: 5 })).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-zip-too-large",
  });
});

test("a missing file is not found, and so is an artifact the person cannot read", async () => {
  const artifact = await f.make("Gone path");
  await expect(download(artifact, f.bob, { path: "nope.md" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const hidden = await f.make("Hidden", undefined, { target: `#${f.privateChannel}` });
  await expect(download(hidden, f.bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(download(hidden, f.bob, { path: "plan.md" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

const preview = (artifactId: string, userId: string, path: string, version?: number) =>
  artifactFilePreview(
    { reads: f.artifacts.reads, blobs: f.blobs },
    { workspaceId: f.workspaceId, artifactId, userId, path, version },
  );

test("a file preview gives text for text and nothing for an image or the rest", async () => {
  const artifact = await f.make("Previews", {
    "plan.md": "# Plan\n",
    "notes.txt": "line one\nline two\n",
    "pic.png": "not really a png",
    "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "blob.bin": "\u0000\u0001binary",
    "big.txt": "x".repeat(2_000_000),
  });
  expect(await preview(artifact, f.bob, "notes.txt")).toMatchObject({
    path: "notes.txt",
    text: "line one\nline two\n",
    sizeBytes: 18,
  });
  expect(await preview(artifact, f.bob, "pic.png")).toEqual({
    path: "pic.png",
    sizeBytes: 16,
    contentType: "image/png",
    text: null,
  });
  expect(await preview(artifact, f.bob, "logo.svg")).toMatchObject({ text: null });
  expect(await preview(artifact, f.bob, "blob.bin")).toMatchObject({ text: null });
  expect(await preview(artifact, f.bob, "big.txt")).toMatchObject({ text: null });
  await expect(preview(artifact, f.bob, "missing.txt")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a file preview is of the version asked for", async () => {
  const artifact = await f.make("Versioned preview", { "plan.md": "one\n" });
  await f.pushText(artifact, f.agents.writer, "two\n");
  expect((await preview(artifact, f.bob, "plan.md", 1)).text).toBe("one\n");
  expect((await preview(artifact, f.bob, "plan.md")).text).toBe("two\n");
});
