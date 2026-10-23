import { describe, expect, test } from "bun:test";

import { isAppError } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";
import {
  AppRegistry,
  type AppRegistryStore,
  type AppView,
} from "#src/server/apps/app-registry.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import { validateImage } from "#src/server/files/image-upload.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import {
  createPublicImageDelivery,
  type ProfileImageStyle,
} from "#src/server/files/public-image-delivery.server";

/**
 * An app's logo, without a database: who may set and reset it, which files it takes, and that the
 * replaced, reset or deleted app's object leaves the image store. Persistence and the surfaces that
 * show it are `app-registry.integration.test.ts`.
 */
const WORKSPACE = "workspace-1";

const ownApp: AppView = {
  key: "acme-notes",
  ownerWorkspaceId: WORKSPACE,
  developer: "Acme",
  name: "Acme Notes",
  description: "",
  whenToUse: "",
  homepageUrl: null,
  agentManifestUrl: null,
  redirectUris: [],
  category: "other",
  allowedScopes: ["openid", "profile", "identity"],
  logoObjectKey: null,
  publishStatus: "private",
  secretRotatedAt: null,
  createdAt: new Date("2026-10-20T00:00:00.000Z"),
  updatedAt: new Date("2026-10-20T00:00:00.000Z"),
};
const othersApp: AppView = { ...ownApp, key: "their-notes", ownerWorkspaceId: "workspace-2" };

const png = (size = 9) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], "logo.png", { type: "image/png" });
};
const gifOf = (magic: string, size = 9) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(magic));
  return new File([bytes], "logo.gif", { type: "image/gif" });
};
const gif = gifOf("GIF89a");
const webp = new File(
  [new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")],
  "l.webp",
  {
    type: "image/webp",
  },
);
const textAsPng = new File(["not an image"], "logo.png", { type: "image/png" });

function memoryStorage() {
  const objects = new Map<string, Blob>();
  const storage: FileStorage = {
    put: async (key, file) => {
      objects.set(key, file);
    },
    open: async (key) => {
      const body = objects.get(key);
      return body ? { body, contentType: null, sizeBytes: body.size } : null;
    },
    remove: async (key) => {
      objects.delete(key);
    },
    head: async () => null,
  };
  return { objects, storage };
}

/** The two apps, their logos, and the roles in `WORKSPACE`; `viewers` are the people of a
 * Workspace where the app is installed. With `losesRace`, the next logo write finds the logo
 * already changed; `beforeDelete` runs just before the row goes, as a racing write would. */
function fixture(
  roles: Record<string, WorkspaceMemberRole>,
  {
    viewers = Object.keys(roles),
    losesRace = false,
    beforeDelete = async (_apps: Map<string, AppView>, _storage: FileStorage) => {},
  } = {},
) {
  const apps = new Map([ownApp, othersApp].map((app) => [app.key, { ...app }]));
  const contentTypes = new Map<string, string>();
  const { objects, storage } = memoryStorage();
  const store: AppRegistryStore = {
    findMember: async (_workspaceId, userId) => {
      const role = roles[userId];
      return role && { role, workspaceSlug: "acme" };
    },
    listForWorkspace: async () => [...apps.values()],
    find: async (key) => {
      const app = apps.get(key);
      return app && { ...app };
    },
    create: async () => undefined,
    update: async (_workspaceId, key) => apps.get(key),
    delete: async (workspaceId, key) => {
      await beforeDelete(apps, storage);
      const app = apps.get(key);
      if (app?.ownerWorkspaceId !== workspaceId) return undefined;
      apps.delete(key);
      return { logoObjectKey: app.logoObjectKey };
    },
    replaceLogo: async (workspaceId, key, from, to) => {
      const app = apps.get(key);
      if (!app || app.ownerWorkspaceId !== workspaceId || app.logoObjectKey !== from) return false;
      if (losesRace) {
        app.logoObjectKey = "workspaces/workspace-1/apps/acme-notes/logos/other/original";
        return false;
      }
      app.logoObjectKey = to?.objectKey ?? null;
      if (to) contentTypes.set(to.objectKey, to.contentType);
      return true;
    },
    findLogo: async ({ workspaceId, key, viewerUserId }) => {
      const app = apps.get(key);
      if (!app?.logoObjectKey || app.ownerWorkspaceId !== workspaceId) return undefined;
      if (!viewers.includes(viewerUserId)) return undefined;
      return { objectKey: app.logoObjectKey, contentType: contentTypes.get(app.logoObjectKey)! };
    },
  };
  const failures: unknown[] = [];
  const registry = new AppRegistry(store, {
    storage: async () => storage,
    removalFailed: (error) => failures.push(error),
  });
  return { registry, apps, objects, storage, failures };
}

const actor = (actorUserId: string) => ({ workspaceId: WORKSPACE, actorUserId });

async function errorCodeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

describe("an app's logo", () => {
  test("its Workspace's owner or admin uploads one, kept in the image store under the Workspace", async () => {
    for (const role of ["owner", "admin"] as const) {
      const { registry, apps, objects } = fixture({ [role]: role });
      const app = await registry.setAppLogo(actor(role), ownApp.key, png());
      const key = apps.get(ownApp.key)!.logoObjectKey!;
      expect(app.logoObjectKey).toBe(key);
      expect(key).toMatch(
        /^workspaces\/workspace-1\/apps\/acme-notes\/logos\/[0-9a-f-]{36}\/original$/,
      );
      expect([...objects.keys()]).toEqual([key]);
    }
  });

  test("a plain member, or someone outside the Workspace, sets or resets none", async () => {
    const { registry, apps, objects } = fixture({ member: "member" });
    for (const actorUserId of ["member", "outsider"]) {
      expect(await errorCodeOf(registry.setAppLogo(actor(actorUserId), ownApp.key, png()))).toBe(
        "ACCESS_DENIED",
      );
      expect(await errorCodeOf(registry.resetAppLogo(actor(actorUserId), ownApp.key))).toBe(
        "ACCESS_DENIED",
      );
    }
    // A member is refused before the file is judged, so a bad one tells them nothing more.
    expect(await errorCodeOf(registry.setAppLogo(actor("member"), ownApp.key, gif))).toBe(
      "ACCESS_DENIED",
    );
    expect(apps.get(ownApp.key)!.logoObjectKey).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("an admin finds no other Workspace's app, built-in app or unknown app to give a logo", async () => {
    const { registry, objects } = fixture({ admin: "admin" });
    for (const key of [othersApp.key, "system.cleaner", "no-such-app"]) {
      expect(await errorCodeOf(registry.setAppLogo(actor("admin"), key, png()))).toBe("NOT_FOUND");
      expect(await errorCodeOf(registry.resetAppLogo(actor("admin"), key))).toBe("NOT_FOUND");
    }
    expect(objects.size).toBe(0);
  });

  test("takes a JPEG, PNG, GIF or WebP of at most 5 MB whose bytes are that image, nothing else", async () => {
    const { registry, objects } = fixture({ owner: "owner" });
    for (const file of [
      textAsPng,
      gifOf("GIF90a"),
      new File([new TextEncoder().encode("GIF89a")], "logo.png", { type: "image/png" }),
      png(5 * 1024 * 1024 + 1),
      gifOf("GIF89a", 5 * 1024 * 1024 + 1),
      new File([], "empty.png", { type: "image/png" }),
      new File([new TextEncoder().encode("<svg/>")], "logo.svg", { type: "image/svg+xml" }),
    ])
      expect(await errorCodeOf(registry.setAppLogo(actor("owner"), ownApp.key, file))).toBe(
        "INVALID_INPUT",
      );
    expect(objects.size).toBe(0);
    for (const file of [png(), gifOf("GIF87a"), gif, webp])
      expect([
        file.type,
        await errorCodeOf(registry.setAppLogo(actor("owner"), ownApp.key, file)),
      ]).toEqual([file.type, undefined]);
  });

  test("a GIF logo is served as image/gif", async () => {
    const { registry } = fixture({ owner: "owner" });
    await registry.setAppLogo(actor("owner"), ownApp.key, gif);
    expect((await registry.readAppLogo("owner", WORKSPACE, ownApp.key)).contentType).toBe(
      "image/gif",
    );
  });

  test("a GIF is an app logo's only: avatars and icons still refuse one", async () => {
    await expect(validateImage(gif)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("a new logo replaces the old one, whose object is removed", async () => {
    const { registry, apps, objects } = fixture({ owner: "owner" });
    await registry.setAppLogo(actor("owner"), ownApp.key, png());
    const first = apps.get(ownApp.key)!.logoObjectKey!;
    await registry.setAppLogo(actor("owner"), ownApp.key, png(12));
    const second = apps.get(ownApp.key)!.logoObjectKey!;
    expect(second).not.toBe(first);
    expect([...objects.keys()]).toEqual([second]);
  });

  test("reset goes back to the monogram and removes the object", async () => {
    const { registry, apps, objects } = fixture({ owner: "owner" });
    await registry.setAppLogo(actor("owner"), ownApp.key, png());
    const app = await registry.resetAppLogo(actor("owner"), ownApp.key);
    expect(app.logoObjectKey).toBeNull();
    expect(apps.get(ownApp.key)!.logoObjectKey).toBeNull();
    expect(objects.size).toBe(0);
    // Resetting an app with no logo changes nothing and is not an error.
    expect(await errorCodeOf(registry.resetAppLogo(actor("owner"), ownApp.key))).toBeUndefined();
  });

  test("deleting the app removes its logo's object", async () => {
    const { registry, apps, objects } = fixture({ owner: "owner" });
    await registry.setAppLogo(actor("owner"), ownApp.key, png());
    await registry.deleteApp(actor("owner"), ownApp.key);
    expect(apps.has(ownApp.key)).toBe(false);
    expect(objects.size).toBe(0);
  });

  test("deleting the app removes the logo its row had when it went, even one uploaded meanwhile", async () => {
    const raced = "workspaces/workspace-1/apps/acme-notes/logos/raced/original";
    const { registry, objects } = fixture(
      { owner: "owner" },
      {
        beforeDelete: async (apps, storage) => {
          await storage.put(raced, png(), "image/png");
          apps.get(ownApp.key)!.logoObjectKey = raced;
        },
      },
    );
    await registry.deleteApp(actor("owner"), ownApp.key);
    expect(objects.size).toBe(0);
  });

  test("an object that cannot be removed is reported, and the committed change stands", async () => {
    const { registry, apps, storage, failures } = fixture({ owner: "owner" });
    await registry.setAppLogo(actor("owner"), ownApp.key, png());
    const broken = new Error("store down");
    storage.remove = async () => {
      throw broken;
    };
    await registry.resetAppLogo(actor("owner"), ownApp.key);
    expect(apps.get(ownApp.key)!.logoObjectKey).toBeNull();
    expect(failures).toEqual([broken]);
  });

  test("an upload that loses a race to another change is CONFLICT and leaves no object behind", async () => {
    const { registry, objects } = fixture({ owner: "owner" }, { losesRace: true });
    expect(await errorCodeOf(registry.setAppLogo(actor("owner"), ownApp.key, png()))).toBe(
      "CONFLICT",
    );
    expect(objects.size).toBe(0);
  });

  test("people of a Workspace where it is installed read it; anyone else finds none", async () => {
    const { registry } = fixture({ owner: "owner", member: "member" }, { viewers: ["member"] });
    await registry.setAppLogo(actor("owner"), ownApp.key, png());
    const logo = await registry.readAppLogo("member", WORKSPACE, ownApp.key);
    expect(logo.contentType).toBe("image/png");
    expect(await new Response(logo.body).arrayBuffer()).toEqual(await png().arrayBuffer());
    for (const [userId, workspaceId] of [
      ["outsider", WORKSPACE],
      ["member", "workspace-2"],
    ] as const)
      expect(await errorCodeOf(registry.readAppLogo(userId, workspaceId, ownApp.key))).toBe(
        "NOT_FOUND",
      );
  });
});

describe("an app logo's URL", () => {
  const key = "workspaces/workspace-1/apps/acme-notes/logos/logo-1/original";
  const delivery = createPublicImageDelivery({ baseUrl: "https://images-staging.coforge.cn" });
  const cdn = (objectKey: string, style: ProfileImageStyle) =>
    delivery?.url(objectKey, style) ?? null;

  test("is none without a logo", () => {
    expect(appLogoUrl(WORKSPACE, ownApp.key, null, cdn)).toBeNull();
  });

  test("is the image CDN's, at the icon size, when this deployment has one", () => {
    expect(appLogoUrl(WORKSPACE, ownApp.key, key, cdn)).toBe(
      `https://images-staging.coforge.cn/${key}?x-oss-process=style/icon256`,
    );
  });

  test("is otherwise the app's own route, versioned by the stored object", () => {
    expect(appLogoUrl(WORKSPACE, ownApp.key, key, () => null)).toBe(
      "/api/workspaces/workspace-1/apps/acme-notes/logo?v=logo-1",
    );
  });
});
