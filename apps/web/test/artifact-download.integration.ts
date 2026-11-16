import { afterAll, beforeAll, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import {
  artifactDownload,
  artifactFilePreview,
} from "#src/server/artifacts/artifact-download.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("dl");
});
afterAll(() => f.cleanup());

const download = (
  artifactId: string,
  userId: string,
  extra: { path?: string; limit?: number } = {},
) =>
  artifactDownload(
    { reads: f.artifacts.reads, blobs: f.blobs },
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

test("every file downloads as a zip named for the artifact, paths kept", async () => {
  const artifact = await f.make("Pair zip", { "plan.md": "# Plan\n", "data/a.csv": "x,y\n1,2\n" });
  const response = await download(artifact, f.bob);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toContain("Pair%20zip.zip");
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(Object.keys(entries).sort()).toEqual(["data/a.csv", "plan.md"]);
  expect(new TextDecoder().decode(entries["plan.md"])).toBe("# Plan\n");
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

test("a file preview gives text for text, a data URL for an image, nothing for the rest", async () => {
  const artifact = await f.make("Previews", {
    "plan.md": "# Plan\n",
    "notes.txt": "line one\nline two\n",
    "pic.png": "not really a png",
    "blob.bin": "\u0000\u0001binary",
    "big.txt": "x".repeat(2_000_000),
  });
  expect(await preview(artifact, f.bob, "notes.txt")).toMatchObject({
    path: "notes.txt",
    text: "line one\nline two\n",
    dataUrl: null,
    sizeBytes: 18,
  });
  const image = await preview(artifact, f.bob, "pic.png");
  expect(image.text).toBeNull();
  expect(image.dataUrl).toStartWith("data:image/png;base64,");
  expect(await preview(artifact, f.bob, "blob.bin")).toMatchObject({ text: null, dataUrl: null });
  expect(await preview(artifact, f.bob, "big.txt")).toMatchObject({ text: null, dataUrl: null });
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
