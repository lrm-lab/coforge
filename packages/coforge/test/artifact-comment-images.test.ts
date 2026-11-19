import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { decodeAgentArtifactRequest, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { runArtifact } from "../src/artifact-commands";
import { isImage } from "../src/artifact-images";
import { C1, ID, REVIEW, comment, invocation } from "./artifact-comment-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("review accepts image-only comments with omitted or empty body and decodes cleanly", async () => {
  const dir = await makeTempDir("review-img-");
  const png = join(dir, "a.png");
  await writeFile(png, PNG_BYTES);
  const sent: AgentArtifactRequest[] = [];
  const uploaded: string[] = [];
  const transport = {
    artifact: async (request: AgentArtifactRequest) => {
      sent.push(request);
      return {
        review: {
          id: REVIEW,
          version: 1,
          body: null,
          author: { kind: "agent", name: "Bot" },
          createdAt: "2026-11-12T09:30:00.000Z",
        },
        comments: [comment(C1, { reviewId: REVIEW, body: "" })],
      };
    },
    artifactUpload: async (sha256: string) => {
      uploaded.push(sha256);
    },
  };
  await runArtifact(invocation(["review", ID, "--json"]), transport, async () =>
    JSON.stringify([{ images: [png] }, { body: "", images: [png] }]),
  );
  expect(uploaded).toHaveLength(2);
  expect(sent).toHaveLength(1);
  expect(decodeAgentArtifactRequest(sent[0])).not.toBeNull();
  expect(sent[0]).toMatchObject({
    operation: "review",
    artifact: ID,
    comments: [
      { body: "", images: [uploaded[0]] },
      { body: "", images: [uploaded[1]] },
    ],
  });
});

test("comment --image skips stdin on TTY, reads piped stdin, validates all images before uploading any, and checks GIF87a/GIF89a", async () => {
  const dir = await makeTempDir("img-c7-");
  const png = join(dir, "a.png");
  await writeFile(png, PNG_BYTES);
  const bad = join(dir, "bad.txt");
  await writeFile(bad, "not an image");
  const sent: AgentArtifactRequest[] = [];
  const uploaded: string[] = [];
  const transport = {
    artifact: async (request: AgentArtifactRequest) => {
      sent.push(request);
      return comment(C1, { body: "" });
    },
    artifactUpload: async (sha256: string) => {
      uploaded.push(sha256);
    },
  };

  let stdinCalled = false;
  await runArtifact(
    invocation(["comment", ID, "--image", png]),
    transport,
    () => {
      stdinCalled = true;
      return new Promise<string>(() => {});
    },
    true,
  );
  expect(stdinCalled).toBe(false);
  expect(uploaded).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("body");

  uploaded.length = 0;
  sent.length = 0;
  await runArtifact(
    invocation(["comment", ID, "--image", png]),
    transport,
    async () => "With caption\n",
    false,
  );
  expect(uploaded).toHaveLength(1);
  expect(sent[0]).toMatchObject({ operation: "comment", body: "With caption", images: uploaded });

  uploaded.length = 0;
  sent.length = 0;
  await expect(
    runArtifact(
      invocation(["comment", ID, "--image", png, "--image", bad]),
      transport,
      async () => "",
      false,
    ),
  ).rejects.toThrow("not a PNG, JPEG, GIF or WebP");
  expect(uploaded).toEqual([]);
  expect(sent).toEqual([]);

  await expect(
    runArtifact(invocation(["review", ID]), transport, async () =>
      JSON.stringify([
        { body: "first", images: [png] },
        { body: "second", images: [bad] },
      ]),
    ),
  ).rejects.toThrow("not a PNG, JPEG, GIF or WebP");
  expect(uploaded).toEqual([]);
  expect(sent).toEqual([]);

  expect(isImage(new TextEncoder().encode("GIF87a\x00\x00"))).toBe(true);
  expect(isImage(new TextEncoder().encode("GIF89a\x00\x00"))).toBe(true);
  expect(isImage(new TextEncoder().encode("GIF8xx\x00\x00"))).toBe(false);
  expect(isImage(new TextEncoder().encode("GIF8"))).toBe(false);
});
