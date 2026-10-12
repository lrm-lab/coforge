import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { avatarPresetFile, avatarPresets } from "#src/features/profiles/avatar-presets";

describe("platform avatar presets", () => {
  test("offers thirty distinct pictures, each served from public/avatars", () => {
    expect(avatarPresets).toHaveLength(30);
    expect(new Set(avatarPresets.map((preset) => preset.id)).size).toBe(30);
    for (const preset of avatarPresets) {
      expect(preset.url).toBe(`/avatars/${preset.id}.webp`);
      expect(existsSync(`public${preset.url}`)).toBeTrue();
    }
  });

  test("choosing one makes the file the avatar upload takes", async () => {
    const preset = avatarPresets[0]!;
    const requested: string[] = [];
    const file = await avatarPresetFile(preset, async (url) => {
      requested.push(String(url));
      return new Response(new Blob(["image-bytes"], { type: "image/webp" }));
    });
    expect(requested).toEqual([preset.url]);
    expect(file.name).toBe("portrait-01.webp");
    expect(file.type).toBe("image/webp");
    expect(await file.text()).toBe("image-bytes");
  });

  test("a picture that cannot be read is an error, not an empty avatar", async () => {
    const preset = avatarPresets[0]!;
    await expect(
      avatarPresetFile(preset, async () => new Response(null, { status: 404 })),
    ).rejects.toThrow();
  });
});
