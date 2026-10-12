import { describe, expect, test } from "bun:test";

import { saveUserProfileInputSchema } from "#src/features/profiles/profile.schemas";
import { AppError } from "#src/lib/app-error";
import { PROFILE_IMAGE_MAX_BYTES, storeUserAvatar } from "#src/server/profiles/user-avatar.server";
import {
  handleAvatarDelete,
  handleAvatarDownload,
  handleAvatarUpload,
} from "#src/routes/api/me/avatar";
import { handleWorkspaceUserAvatar } from "#src/server/profiles/workspace-user-avatar.server";
import { PrismaUserProfileRepository } from "#src/server/db/repositories/user-profile.repositories.server";

test("workspace user avatar serves the requested sender only to workspace members", async () => {
  const response = await handleWorkspaceUserAvatar(
    new Request("https://coforge.test/api/workspaces/workspace-1/users/sender/avatar?v=version-1"),
    "workspace-1",
    "sender",
    {
      authenticate: () => ({ id: "viewer" }),
      database: () =>
        ({
          workspaceMembership: {
            findFirst: async (query: unknown) => {
              expect(query).toEqual({
                where: {
                  workspaceId: "workspace-1",
                  userId: "sender",
                  workspace: { members: { some: { userId: "viewer" } } },
                },
                select: { userId: true },
              });
              return { userId: "sender" };
            },
          },
        }) as never,
      read: async (_db, userId) => {
        expect(userId).toBe("sender");
        return { body: new Blob(["sender-image"]), contentType: "image/png" };
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("sender-image");
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
});

describe("saveUserProfileInputSchema", () => {
  const parse = (input: { displayName?: string; description?: string }) =>
    saveUserProfileInputSchema.safeParse({ description: "", ...input });

  test("normalizes the name and the description", () => {
    expect(
      saveUserProfileInputSchema.parse({
        displayName: "  Frank   An  ",
        description: "  Building CoForge.  ",
      }),
    ).toEqual({ displayName: "Frank An", description: "Building CoForge." });
  });

  test("the name follows the same rule as the one asked at first sign-in", () => {
    // Counted in characters, not UTF-16 units: 80 emoji are 160 units and fit, 81 do not.
    expect(parse({ displayName: "\u{1F600}".repeat(80) }).success).toBe(true);
    expect(parse({ displayName: "\u{1F600}".repeat(81) }).success).toBe(false);
    for (const refused of [
      "@ada",
      "System",
      "\u200b",
      "\u2800",
      "Ada\u202eLovelace",
      "Ada\u0000",
    ]) {
      expect(parse({ displayName: refused }).success, refused).toBe(false);
    }
  });

  test("a refused name says why: empty, too_long or refused", () => {
    const problem = (input: { displayName: string }) => {
      const parsed = parse(input);
      return parsed.success ? undefined : parsed.error.issues[0]?.message;
    };
    expect(problem({ displayName: "  " })).toBe("empty");
    expect(problem({ displayName: "a".repeat(81) })).toBe("too_long");
    expect(problem({ displayName: "system" })).toBe("refused");
    expect(problem({ displayName: "@bot" })).toBe("refused");
  });

  test("composes accents (NFC) and collapses every kind of internal whitespace", () => {
    const parsed = parse({ displayName: "Jose\u0301\t\u00a0 Garci\u0301a\n" });
    expect(parsed.success && parsed.data.displayName).toBe("Jos\u00e9 Garc\u00eda");
  });

  test("a name is required and may not be blank", () => {
    expect(parse({ displayName: "" }).success).toBeFalse();
    expect(parse({ displayName: "   \n\t " }).success).toBeFalse();
    expect(saveUserProfileInputSchema.safeParse({ description: "" }).success).toBeFalse();
  });

  test("a name is at most 80 characters once normalized", () => {
    expect(parse({ displayName: "a".repeat(80) }).success).toBeTrue();
    expect(parse({ displayName: "a".repeat(81) }).success).toBeFalse();
    // The spaces collapse first: 80 letters and a doubled space is still 80 letters wide.
    expect(parse({ displayName: `${"a".repeat(39)}   ${"b".repeat(40)}` }).success).toBeTrue();
  });

  test("a name holds no control characters", () => {
    expect(parse({ displayName: "Ada\u0000Lovelace" }).success).toBeFalse();
    expect(parse({ displayName: "Ada\u001b[31mLovelace" }).success).toBeFalse();
    expect(parse({ displayName: "Count\u0007ess" }).success).toBeFalse();
  });
});

describe("PrismaUserProfileRepository", () => {
  test("names the person by the name teammates see", async () => {
    const named = profileRepository({ username: "ada", displayName: "Countess" });
    expect(await named.repository.get("user-1")).toMatchObject({
      name: "Countess",
      displayName: "Countess",
    });
  });

  test("says when the person joined, as an ISO instant", async () => {
    const joined = profileRepository({ username: "ada", displayName: "Countess" });
    expect((await joined.repository.get("user-1")).joinedAt).toBe("2026-07-23T01:02:03.000Z");
  });

  test("says whether the person has been asked for a name", async () => {
    const unasked = profileRepository({ username: "ada", displayName: null });
    expect((await unasked.repository.get("user-1")).named).toBe(false);

    const asked = profileRepository({ username: "ada", displayName: "Countess" });
    expect((await asked.repository.get("user-1")).named).toBe(true);
  });

  test("a person who has not given a name is still named, by the username fallback", async () => {
    const unnamed = profileRepository({ username: "ada", displayName: null });
    expect(await unnamed.repository.get("user-1")).toMatchObject({
      name: "ada",
      displayName: null,
    });
  });

  test("saving stores the name and the description", async () => {
    const { repository, updates } = profileRepository({ username: "ada", displayName: null });
    const saved = await repository.set("user-1", {
      displayName: "Countess",
      description: "Building CoForge.",
    });
    expect(updates).toEqual([{ displayName: "Countess", description: "Building CoForge." }]);
    expect(saved).toEqual({
      name: "Countess",
      displayName: "Countess",
      description: "Building CoForge.",
    });
  });

  test("saving for a person who no longer exists is NOT_FOUND, not a database error", async () => {
    const db = {
      user: {
        update: async () => {
          throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        },
      },
    } as never;
    await expect(
      new PrismaUserProfileRepository(db).set("gone", {
        displayName: "Ada Lovelace",
        description: "",
      }),
    ).rejects.toEqual(new AppError("NOT_FOUND"));
  });

  test("any other database failure while saving is not disguised as NOT_FOUND", async () => {
    const failure = Object.assign(new Error("connection lost"), { code: "P1001" });
    const db = {
      user: {
        update: async () => {
          throw failure;
        },
      },
    } as never;
    await expect(
      new PrismaUserProfileRepository(db).set("user-1", {
        displayName: "Ada Lovelace",
        description: "",
      }),
    ).rejects.toBe(failure);
  });
});

test("profile image upload rejects unsupported and oversized files before persistence", async () => {
  const db = persistenceMustNotBeTouched();

  await expect(
    storeUserAvatar(db, {
      userId: "user-1",
      file: new File(["text"], "avatar.txt", { type: "text/plain" }),
    }),
  ).rejects.toEqual(new AppError("INVALID_INPUT"));

  await expect(
    storeUserAvatar(db, {
      userId: "user-1",
      file: new File([new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1)], "avatar.png", {
        type: "image/png",
      }),
    }),
  ).rejects.toEqual(new AppError("INVALID_INPUT"));
});

test("profile image HTTP boundary uploads, serves inline, and removes the current user's image", async () => {
  const stored = {
    avatarUrl: "/api/me/avatar?v=avatar-version",
  };
  const upload = await handleAvatarUpload(avatarUploadRequest(), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async (_db, input) => {
      expect(input.userId).toBe("user-1");
      expect(input.file.type).toBe("image/png");
      return stored;
    },
    read: async () => {
      throw new Error("must not read during upload");
    },
    remove: async () => {
      throw new Error("must not remove during upload");
    },
  });
  expect(upload.status).toBe(200);
  expect(await upload.json()).toEqual(stored);

  const download = await handleAvatarDownload(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => stored,
    read: async () => ({
      body: Bun.file(import.meta.path),
      contentType: "image/png",
    }),
    remove: async () => {},
  });
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("image/png");
  expect(download.headers.get("content-disposition")).toBe("inline");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(download.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

  let removedUserId = "";
  const removal = await handleAvatarDelete(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => stored,
    read: async () => {
      throw new Error("must not read during removal");
    },
    remove: async (_db, userId) => {
      removedUserId = userId;
    },
  });
  expect(removal.status).toBe(204);
  expect(removedUserId).toBe("user-1");
});

test("profile image HTTP boundary rejects unauthenticated requests", async () => {
  const response = await handleAvatarDownload(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => {
      throw new AppError("ACCESS_DENIED");
    },
    database: () => ({}) as never,
    store: async () => ({ avatarUrl: null }),
    read: async () => {
      throw new Error("must not read without authentication");
    },
    remove: async () => {},
  });

  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

function profileRepository(row: { username: string; displayName: string | null }) {
  const updates: unknown[] = [];
  const stored = {
    ...row,
    description: "",
    avatarObjectKey: null,
    createdAt: new Date("2026-07-23T01:02:03.000Z"),
  };
  const db = {
    user: {
      // Like the database, answer with only the columns the query selects.
      findUnique: async ({ select }: { select: Record<string, true> }) =>
        Object.fromEntries(
          Object.keys(select).map((key) => [key, stored[key as keyof typeof stored]]),
        ),
      update: async ({ data }: { data: { description: string } }) => {
        updates.push(data);
        return { description: data.description };
      },
    },
  } as never;
  return { repository: new PrismaUserProfileRepository(db), updates };
}

function persistenceMustNotBeTouched() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("persistence must not be touched");
      },
    },
  ) as never;
}

function avatarUploadRequest() {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "avatar.png", {
      type: "image/png",
    }),
  );
  return new Request("https://coforge.test/api/me/avatar", {
    method: "POST",
    body: form,
  });
}
