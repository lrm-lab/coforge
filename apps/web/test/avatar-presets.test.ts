import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  avatarPresetReference,
  avatarPresets,
  avatarPresetUrl,
  isAvatarPresetId,
  isAvatarPresetReference,
} from "#src/features/profiles/avatar-presets";
import {
  avatarUrl,
  workspaceUserAvatarUrl,
} from "#src/server/db/repositories/user-profile.repositories.server";

describe("platform avatar presets", () => {
  test("offers thirty distinct pictures, each served from public/avatars", () => {
    expect(avatarPresets).toHaveLength(30);
    expect(new Set(avatarPresets.map((preset) => preset.id)).size).toBe(30);
    for (const preset of avatarPresets) {
      expect(preset.url).toBe(`/avatars/${preset.id}.webp`);
      expect(existsSync(`public${preset.url}`)).toBeTrue();
    }
  });

  test("a chosen preset is stored as a reference and drawn from public/avatars", () => {
    const reference = avatarPresetReference("portrait-07");

    expect(reference).toBe("preset:portrait-07");
    expect(avatarPresetUrl(reference)).toBe("/avatars/portrait-07.webp");
  });

  test("only the platform's own pictures are presets", () => {
    expect(isAvatarPresetId("portrait-30")).toBeTrue();
    expect(isAvatarPresetId("portrait-31")).toBeFalse();
    expect(isAvatarPresetId("../portrait-01")).toBeFalse();
    expect(avatarPresetUrl("users/u/avatars/a/original")).toBeNull();
    expect(avatarPresetUrl("preset:portrait-99")).toBeNull();
    expect(isAvatarPresetReference("preset:portrait-99")).toBeTrue();
    expect(isAvatarPresetReference("users/u/avatars/a/original")).toBeFalse();
  });

  // The image CDN addresses objects in the image bucket; a preset is not one, so it must never be
  // sent there (that is the request that broke every preset avatar when a bucket lacked its style).
  test("an avatar URL for a preset never goes through the image CDN", () => {
    const cdn = () => "https://images.example/never";

    expect(avatarUrl("preset:portrait-07", cdn)).toBe("/avatars/portrait-07.webp");
    expect(workspaceUserAvatarUrl("workspace-1", "user-1", "preset:portrait-07", cdn)).toBe(
      "/avatars/portrait-07.webp",
    );
    // A reference to a picture the app no longer ships draws the initials, not a CDN request.
    expect(avatarUrl("preset:portrait-99", cdn)).toBeNull();
  });
});
