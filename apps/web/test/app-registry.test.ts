import { describe, expect, test } from "bun:test";

import { isAppError } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";
import {
  AppRegistry,
  type AppRegistryStore,
  type AppView,
} from "#src/server/apps/app-registry.server";

/**
 * Who may change which app, without a database: the registry's own refusals, before any write.
 * Persistence is `app-registry.integration.test.ts`.
 */
const WORKSPACE = "workspace-1";

const ownApp: AppView = {
  key: "acme-notes",
  ownerWorkspaceId: WORKSPACE,
  developer: "Acme",
  name: "Acme Notes",
  description: "",
  whenToUse: "",
  homepageUrl: "https://notes.acme.example/",
  agentManifestUrl: null,
  enableBot: false,
  redirectUris: ["https://notes.acme.example/cb"],
  category: "other",
  allowedScopes: ["openid", "profile", "identity"],
  logoObjectKey: null,
  publishStatus: "private",
  secretRotatedAt: null,
  createdAt: new Date("2026-10-20T00:00:00.000Z"),
  updatedAt: new Date("2026-10-20T00:00:00.000Z"),
};

const LOGO = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "l.png", {
  type: "image/png",
});

/** No image store: these tests never reach one (no app here has a logo, and a refused logo
 * change is refused before it). */
const NO_IMAGES = {
  storage: async () => {
    throw new Error("no image store in these tests");
  },
  removalFailed: () => {},
};

/** A built-in Agent App's key: never in the registry. */
const BUILT_IN_KEY = "system.cleaner";
const othersApp: AppView = { ...ownApp, key: "their-notes", ownerWorkspaceId: "workspace-2" };

/** A store with the Workspace's own app and another Workspace's, whose every write
 * is recorded and answered as done. With `roleAfterApp`, a role read answers only once an app read
 * has, as a slow membership query would. */
function storeWith(roles: Record<string, WorkspaceMemberRole>, { roleAfterApp = false } = {}) {
  const writes: string[] = [];
  const waitingForApp: (() => void)[] = [];
  const store: AppRegistryStore = {
    async findMember(_workspaceId, userId) {
      if (roleAfterApp) await new Promise<void>((resolve) => waitingForApp.push(resolve));
      const role = roles[userId];
      return role && { role, workspaceSlug: "acme" };
    },
    async listForWorkspace() {
      return [ownApp];
    },
    async find(key) {
      for (const resolve of waitingForApp.splice(0)) resolve();
      return [ownApp, othersApp].find((app) => app.key === key);
    },
    async create() {
      writes.push("create");
      return ownApp;
    },
    async update() {
      writes.push("update");
      return ownApp;
    },
    async delete() {
      writes.push("delete");
      return { logoObjectKey: null };
    },
    async replaceLogo() {
      writes.push("logo");
      return true;
    },
    async findLogo() {
      return undefined;
    },
  };
  return { store, writes };
}

async function errorCodeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

const registration = {
  key: "acme-two",
  name: "Acme Two",
  description: "",
  whenToUse: "",
  homepageUrl: "https://two.acme.example/",
  redirectUris: ["https://two.acme.example/cb"],
  category: "other" as const,
  allowedScopes: ["openid", "profile", "identity"],
};

describe("the app registry's authorization", () => {
  const changes = (registry: AppRegistry, actorUserId: string) => {
    const actor = { workspaceId: WORKSPACE, actorUserId };
    // One at a time, so the writes are recorded in this order.
    return [
      () => registry.registerApp(actor, registration),
      () => registry.updateApp(actor, ownApp.key, { name: "Renamed" }),
      () => registry.rotateAppSecret(actor, ownApp.key),
      () => registry.deleteApp(actor, ownApp.key),
    ];
  };

  test("a plain member, or someone outside the Workspace, changes no app", async () => {
    const { store, writes } = storeWith({ member: "member" });
    const registry = new AppRegistry(store, NO_IMAGES);
    for (const actorUserId of ["member", "outsider"])
      for (const attempt of changes(registry, actorUserId))
        expect(await errorCodeOf(attempt())).toBe("ACCESS_DENIED");
    expect(writes).toEqual([]);
  });

  test("a plain member is ACCESS_DENIED whichever app they name, before any app is judged", async () => {
    const { store, writes } = storeWith({ member: "member" }, { roleAfterApp: true });
    const registry = new AppRegistry(store, NO_IMAGES);
    const actor = { workspaceId: WORKSPACE, actorUserId: "member" };
    for (const key of [ownApp.key, BUILT_IN_KEY, othersApp.key, "no-such-app"])
      for (const attempt of [
        () => registry.updateApp(actor, key, { name: "Renamed" }),
        () => registry.rotateAppSecret(actor, key),
        () => registry.setAppLogo(actor, key, LOGO),
        () => registry.resetAppLogo(actor, key),
        () => registry.deleteApp(actor, key),
      ])
        expect([key, await errorCodeOf(attempt())]).toEqual([key, "ACCESS_DENIED"]);
    expect(writes).toEqual([]);
  });

  test("an admin finds no built-in app, another Workspace's or an unknown one to change", async () => {
    const { store, writes } = storeWith({ admin: "admin" });
    const registry = new AppRegistry(store, NO_IMAGES);
    const actor = { workspaceId: WORKSPACE, actorUserId: "admin" };
    for (const key of [BUILT_IN_KEY, othersApp.key, "no-such-app"])
      for (const attempt of [
        () => registry.updateApp(actor, key, { name: "Renamed" }),
        () => registry.rotateAppSecret(actor, key),
        () => registry.setAppLogo(actor, key, LOGO),
        () => registry.resetAppLogo(actor, key),
        () => registry.deleteApp(actor, key),
      ])
        expect([key, await errorCodeOf(attempt())]).toEqual([key, "NOT_FOUND"]);
    expect(writes).toEqual([]);
  });

  test("a plain member still lists the Workspace's apps", async () => {
    const { store } = storeWith({ member: "member" });
    const { apps } = await new AppRegistry(store, NO_IMAGES).listWorkspaceApps({
      workspaceId: WORKSPACE,
      actorUserId: "member",
    });
    expect(apps.map((app) => app.key)).toEqual([ownApp.key]);
  });

  test("its owner and admins register, change, rotate and delete its apps", async () => {
    const { store, writes } = storeWith({ owner: "owner", admin: "admin" });
    const registry = new AppRegistry(store, NO_IMAGES);
    for (const actorUserId of ["owner", "admin"])
      for (const attempt of changes(registry, actorUserId))
        expect(await errorCodeOf(attempt())).toBeUndefined();
    // Rotating a secret is an update, too.
    const oneEach = ["create", "update", "update", "delete"];
    expect(writes).toEqual([...oneEach, ...oneEach]);
  });

  test("an input a rule refuses writes nothing", async () => {
    const { store, writes } = storeWith({ owner: "owner" });
    const registry = new AppRegistry(store, NO_IMAGES);
    const actor = { workspaceId: WORKSPACE, actorUserId: "owner" };
    expect(await errorCodeOf(registry.registerApp(actor, { ...registration, key: "x" }))).toBe(
      "INVALID_INPUT",
    );
    expect(
      await errorCodeOf(registry.updateApp(actor, ownApp.key, { allowedScopes: ["email"] })),
    ).toBe("INVALID_INPUT");
    // A caller's JSON of the wrong shape is refused the same way, naming the field.
    await expect(
      registry.registerApp(actor, {
        ...registration,
        redirectUris: "https://a.example/cb",
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "app-redirect-uris-invalid" });
    await expect(registry.updateApp(actor, ownApp.key, { name: 5 } as never)).rejects.toMatchObject(
      { code: "INVALID_INPUT", errorId: "app-name-invalid" },
    );
    expect(writes).toEqual([]);
  });
});

describe("a registration without a key", () => {
  /** A store that records the key of every create, and answers each with `taken` in turn (a
   * taken key is `undefined`), then with the app. */
  function recordingStore(taken: boolean[]) {
    const keys: string[] = [];
    const { store } = storeWith({ owner: "owner" });
    const recording: AppRegistryStore = {
      ...store,
      async create(input) {
        keys.push(input.app.key);
        return taken[keys.length - 1] ? undefined : { ...ownApp, key: input.app.key };
      },
    };
    return { store: recording, keys };
  }
  const suffixes =
    (...values: string[]) =>
    () =>
      values.shift() ?? "zzzzzz";
  const actor = { workspaceId: WORKSPACE, actorUserId: "owner" };

  test("gets a key made from the app's name", async () => {
    const { store, keys } = recordingStore([]);
    const registry = new AppRegistry(store, NO_IMAGES, { keySuffix: suffixes("x7k2q9") });
    const { app } = await registry.registerApp(actor, { ...registration, key: "" });
    expect(keys).toEqual(["acme-two-x7k2q9"]);
    expect(app.key).toBe("acme-two-x7k2q9");
  });

  test("tries another suffix when the key it made is taken", async () => {
    const { store, keys } = recordingStore([true, true]);
    const registry = new AppRegistry(store, NO_IMAGES, {
      keySuffix: suffixes("aaaaaa", "bbbbbb", "cccccc"),
    });
    await registry.registerApp(actor, { ...registration, key: "  " });
    expect(keys).toEqual(["acme-two-aaaaaa", "acme-two-bbbbbb", "acme-two-cccccc"]);
  });

  test("gives up with CONFLICT when every key it makes is taken", async () => {
    const { store, keys } = recordingStore(Array(20).fill(true));
    const registry = new AppRegistry(store, NO_IMAGES);
    expect(await errorCodeOf(registry.registerApp(actor, { ...registration, key: "" }))).toBe(
      "CONFLICT",
    );
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.length).toBeLessThan(20);
  });

  test("a key it was given that is taken is refused at once, never replaced", async () => {
    const { store, keys } = recordingStore([true, false]);
    const registry = new AppRegistry(store, NO_IMAGES);
    await expect(registry.registerApp(actor, registration)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "app-key-taken",
    });
    expect(keys).toEqual(["acme-two"]);
  });

  test("a bad name is still refused for the name, not the key made from it", async () => {
    const { store, keys } = recordingStore([]);
    await expect(
      new AppRegistry(store, NO_IMAGES).registerApp(actor, { ...registration, key: "", name: "" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "app-name-invalid" });
    expect(keys).toEqual([]);
  });
});
