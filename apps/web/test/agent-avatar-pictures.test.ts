import { describe, expect, test } from "bun:test";

import {
  AGENT_AVATAR_POOL_VERSION,
  decodeInlinedPicture,
  randomAgentAvatarPicture,
} from "#src/server/agents/agent-avatar-pictures.server";

const isWebp = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
  new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";

describe("Agent avatar pictures", () => {
  test("the draw reaches all twenty-four pictures, each a distinct WebP image", async () => {
    const seen = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const picture = await randomAgentAvatarPicture(() => (index + 0.5) / 24);
      expect(picture.id).toBe(`ai-${String(index + 1).padStart(2, "0")}`);
      expect(picture.file.type).toBe("image/webp");
      const bytes = await picture.file.bytes();
      expect(isWebp(bytes)).toBeTrue();
      seen.add(Buffer.from(bytes).toString("base64"));
    }
    expect(seen.size).toBe(24);
  });

  test("a draw at the top of the range still lands on the last picture", async () => {
    const last = await randomAgentAvatarPicture(() => 23.5 / 24);
    const clamped = await randomAgentAvatarPicture(() => 0.9999999);

    expect(clamped.id).toBe(last.id);
    expect(await clamped.file.bytes()).toEqual(await last.file.bytes());
  });

  test("the pool is versioned, so a later replacement can find every picture of this one", () => {
    expect(AGENT_AVATAR_POOL_VERSION).toBe("v1");
  });

  test("a build that left a picture as a bare URL fails instead of storing nothing", async () => {
    expect(await decodeInlinedPicture("data:image/webp;base64,UklGRg==")).toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
    await expect(decodeInlinedPicture("/assets/ai-01-4f2a9c.webp")).rejects.toThrow();
  });
});
