import { afterAll, beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import type { CommentImageBlobs } from "#src/server/artifacts/artifact-comment-images.server";
import { postComment } from "#src/server/artifacts/artifact-comments.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cri");
});
afterAll(() => f.cleanup());

test("a replayed comment prepares no image again", async () => {
  const png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00f" } })
      .png()
      .toBuffer(),
  );
  const sha256 = "b".repeat(64);
  let prepared = 0;
  const blobs = {
    allowed: async () => new Set([sha256]),
    read: async () => {
      prepared++;
      return png;
    },
    upload: async () => ({ sha256: "c".repeat(64) }),
    use: async () => [],
  } as unknown as CommentImageBlobs;
  const artifact = await f.make("Replay images");
  const send = () =>
    postComment(
      f.db,
      blobs,
      { kind: "agent", workspaceId: f.workspaceId, agentId: f.agents.writer },
      {
        artifact,
        body: "see",
        images: [sha256],
        idempotencyKey: "replay-key-1",
      } as never,
    );
  const first = await send();
  const second = await send();
  expect(second.comment.id).toBe(first.comment.id);
  expect(prepared).toBe(1);
});
