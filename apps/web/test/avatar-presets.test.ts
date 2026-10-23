import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  avatarPresetReference,
  avatarPresets,
  avatarPresetUrl,
  isAvatarPresetId,
  isAvatarPresetReference,
} from "#src/features/profiles/avatar-presets";
import { isPersonPicture, personAvatarUrl } from "#src/lib/person-picture";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";
import { isStickerPicture } from "#src/features/avatars/sticker-picture";
import {
  avatarUrl,
  publicAvatarUrl,
  workspaceUserAvatarUrl,
} from "#src/server/db/repositories/user-profile.repositories.server";

describe("platform avatar presets", () => {
  // Frank, 2026-10-24: a person's avatar is one of four cartoon people, not a photo.
  test("offers four cartoon people, each served from public/avatars", () => {
    expect(avatarPresets.map((preset) => preset.id)).toEqual([
      "person-1",
      "person-2",
      "person-3",
      "person-4",
    ]);
    for (const preset of avatarPresets) {
      expect(preset.url).toBe(`/avatars/${preset.id}-1.webp`);
      expect(existsSync(`public${preset.url}`)).toBeTrue();
      expect(isPersonPicture(preset.url)).toBeTrue();
    }
  });

  test("a chosen preset is stored as a reference and drawn from public/avatars", () => {
    const reference = avatarPresetReference("person-3");

    expect(reference).toBe("preset:person-3");
    expect(avatarPresetUrl(reference)).toBe("/avatars/person-3-1.webp");
  });

  test("only the platform's own pictures are presets", () => {
    expect(isAvatarPresetId("person-4")).toBeTrue();
    expect(isAvatarPresetId("person-5")).toBeFalse();
    expect(isAvatarPresetId("portrait-07")).toBeFalse();
    expect(isAvatarPresetId("../person-1")).toBeFalse();
    expect(avatarPresetUrl("users/u/avatars/a/original")).toBeNull();
    expect(avatarPresetUrl("preset:person-99")).toBeNull();
    expect(isAvatarPresetReference("preset:person-99")).toBeTrue();
    expect(isAvatarPresetReference("users/u/avatars/a/original")).toBeFalse();
  });

  test("only the cartoon people's pictures are person pictures", () => {
    expect(isPersonPicture("/avatars/person-2-1.webp")).toBeTrue();
    expect(isPersonPicture("/agent-avatars/mascot-blue-3.webp")).toBeFalse();
    expect(isPersonPicture("/api/me/avatar?v=a")).toBeFalse();
    expect(isPersonPicture(null)).toBeFalse();
    expect(isPersonPicture(undefined)).toBeFalse();
  });
});

// Frank, 2026-10-24: a cartoon person is drawn like an Agent's mascot, as a sticker.
test("a mascot and a cartoon person are sticker pictures; an uploaded photo is not", () => {
  expect(isStickerPicture(mascotStaticUrl("blue"))).toBeTrue();
  expect(isStickerPicture(avatarPresets[0]!.url)).toBeTrue();
  expect(isStickerPicture("/api/me/avatar?v=a")).toBeFalse();
  expect(isStickerPicture("https://images.example/users/u/avatars/a/original")).toBeFalse();
  expect(isStickerPicture(null)).toBeFalse();
});

// Frank, 2026-10-24: someone with no avatar shows the cartoon person their id chooses, resolved
// by one rule on the server and in the browser, and never written to the database.
describe("the cartoon person of someone with no avatar", () => {
  test("is chosen by a stable hash of the user id and spreads over all four people", () => {
    const picked = personAvatarUrl("user-1", null);
    expect(avatarPresets.map((preset) => preset.url)).toContain(picked);
    expect(personAvatarUrl("user-1", null)).toBe(picked);
    const spread = new Set(
      Array.from({ length: 200 }, (_, index) => personAvatarUrl(`user-${index}`, null)),
    );
    expect(spread.size).toBe(avatarPresets.length);
  });

  test("uses the same FNV-1a pool order as the Agent mascots", () => {
    // FNV-1a("user-1") mod 4, pinned so a change of hash or pool order is deliberate.
    expect(personAvatarUrl("user-1", null)).toBe("/avatars/person-1-1.webp");
    expect(personAvatarUrl("user-2", null)).toBe("/avatars/person-2-1.webp");
  });

  test("steps aside for any avatar the person has", () => {
    expect(personAvatarUrl("user-1", "/api/me/avatar?v=a")).toBe("/api/me/avatar?v=a");
    expect(personAvatarUrl("user-1", null)).toBe(personAvatarUrl("user-1", null));
    expect(personAvatarUrl("user-1", undefined)).toBe(personAvatarUrl("user-1", null));
  });
});

// The image CDN addresses objects in the image bucket; a preset is not one, so it must never be
// sent there (that is the request that broke every preset avatar when a bucket lacked its style).
describe("a user's avatar URL", () => {
  const cdn = () => "https://images.example/never";

  test("for a preset never goes through the image CDN", () => {
    expect(avatarUrl("user-1", "preset:person-3", cdn)).toBe("/avatars/person-3-1.webp");
    expect(workspaceUserAvatarUrl("workspace-1", "user-1", "preset:person-3", cdn)).toBe(
      "/avatars/person-3-1.webp",
    );
  });

  test("with no avatar, or a preset this build no longer ships, is the person the id chooses", () => {
    const fallback = personAvatarUrl("user-1", null);
    expect(avatarUrl("user-1", null, cdn)).toBe(fallback);
    expect(avatarUrl("user-1", "preset:portrait-07", cdn)).toBe(fallback);
    expect(workspaceUserAvatarUrl("workspace-1", "user-1", null, cdn)).toBe(fallback);
    expect(workspaceUserAvatarUrl("workspace-1", "user-1", "preset:portrait-07", cdn)).toBe(
      fallback,
    );
  });
});

// Login with CoForge's `picture`: an app cannot read the authenticated avatar route, so it gets a
// platform picture it can fetch (made absolute against the issuer by the userinfo answer).
describe("the avatar URL an app is given", () => {
  const cdn = (key: string) => `https://images.example/${key}`;

  test("is the preset they chose, or the cartoon person their id chooses when they have none", () => {
    expect(publicAvatarUrl("user-1", "preset:person-3", cdn)).toBe("/avatars/person-3-1.webp");
    expect(publicAvatarUrl("user-1", null, cdn)).toBe(personAvatarUrl("user-1", null));
    expect(publicAvatarUrl("user-1", "preset:portrait-07", cdn)).toBe(
      personAvatarUrl("user-1", null),
    );
  });

  test("for an upload is the image CDN's URL, or nothing without one", () => {
    expect(publicAvatarUrl("user-1", "users/u/avatars/a/original", cdn)).toStartWith(
      "https://images.example/",
    );
    expect(publicAvatarUrl("user-1", "users/u/avatars/a/original", () => null)).toBeNull();
  });
});
