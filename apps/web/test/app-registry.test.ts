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
  name: "Acme Notes",
  description: "",
  whenToUse: "",
  homepageUrl: "https://notes.acme.example/",
  redirectUris: ["https://notes.acme.example/cb"],
  resourceUri: null,
  allowedScopes: ["openid"],
  secretRotatedAt: null,
  createdAt: new Date("2026-10-20T00:00:00.000Z"),
  updatedAt: new Date("2026-10-20T00:00:00.000Z"),
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
    async findMemberRole(_workspaceId, userId) {
      if (roleAfterApp) await new Promise<void>((resolve) => waitingForApp.push(resolve));
      return roles[userId];
    },
    async listForWorkspace() {
      return [ownApp];
    },
    async find(key) {
      for (const resolve of waitingForApp.splice(0)) resolve();
      return [ownApp, othersApp].find((app) => app.key === key);
    },
    async findSecretHash() {
      return undefined;
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
      return true;
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
  resourceUri: null,
  allowedScopes: ["openid"],
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
    const registry = new AppRegistry(store);
    for (const actorUserId of ["member", "outsider"])
      for (const attempt of changes(registry, actorUserId))
        expect(await errorCodeOf(attempt())).toBe("ACCESS_DENIED");
    expect(writes).toEqual([]);
  });

  test("a plain member is ACCESS_DENIED whichever app they name, before any app is judged", async () => {
    const { store, writes } = storeWith({ member: "member" }, { roleAfterApp: true });
    const registry = new AppRegistry(store);
    const actor = { workspaceId: WORKSPACE, actorUserId: "member" };
    for (const key of [ownApp.key, BUILT_IN_KEY, othersApp.key, "no-such-app"])
      for (const attempt of [
        () => registry.updateApp(actor, key, { name: "Renamed" }),
        () => registry.rotateAppSecret(actor, key),
        () => registry.deleteApp(actor, key),
      ])
        expect([key, await errorCodeOf(attempt())]).toEqual([key, "ACCESS_DENIED"]);
    expect(writes).toEqual([]);
  });

  test("an admin finds no built-in app, another Workspace's or an unknown one to change", async () => {
    const { store, writes } = storeWith({ admin: "admin" });
    const registry = new AppRegistry(store);
    const actor = { workspaceId: WORKSPACE, actorUserId: "admin" };
    for (const key of [BUILT_IN_KEY, othersApp.key, "no-such-app"])
      for (const attempt of [
        () => registry.updateApp(actor, key, { name: "Renamed" }),
        () => registry.rotateAppSecret(actor, key),
        () => registry.deleteApp(actor, key),
      ])
        expect([key, await errorCodeOf(attempt())]).toEqual([key, "NOT_FOUND"]);
    expect(writes).toEqual([]);
  });

  test("a plain member still lists the Workspace's apps", async () => {
    const { store } = storeWith({ member: "member" });
    const apps = await new AppRegistry(store).listWorkspaceApps({
      workspaceId: WORKSPACE,
      actorUserId: "member",
    });
    expect(apps.map((app) => app.key)).toEqual([ownApp.key]);
  });

  test("its owner and admins register, change, rotate and delete its apps", async () => {
    const { store, writes } = storeWith({ owner: "owner", admin: "admin" });
    const registry = new AppRegistry(store);
    for (const actorUserId of ["owner", "admin"])
      for (const attempt of changes(registry, actorUserId))
        expect(await errorCodeOf(attempt())).toBeUndefined();
    // Rotating a secret is an update, too.
    const oneEach = ["create", "update", "update", "delete"];
    expect(writes).toEqual([...oneEach, ...oneEach]);
  });

  test("an input a rule refuses writes nothing", async () => {
    const { store, writes } = storeWith({ owner: "owner" });
    const registry = new AppRegistry(store);
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
