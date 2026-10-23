import { defineEmitterCases, emitterCase } from "./helpers/app-notification-emitter-cases";
import type { EmitterEnvironment } from "./helpers/app-notification-emitters";
import type { FileStorage } from "#src/server/files/file-storage.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { workspaceMemberDirectory } from "#src/server/workspaces/member-directory-store.server";
import { WorkspaceImages } from "#src/server/workspaces/workspace-images.server";

/**
 * The Workspace events apps are notified of, against local PostgreSQL: each is recorded by the real
 * domain operation, in its transaction. Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points
 * at local PostgreSQL (see `helpers/app-notification-emitters.ts`).
 */

/** A member of the fixture's Workspace for the operation to act on. */
async function addMember(env: EmitterEnvironment, workspaceId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await env.db.user.create({
    data: { displayName: `emit-m-${suffix}`, username: `emit-m-${suffix}` },
  });
  await env.db.workspaceMembership.create({
    data: { workspaceId, userId: user.id, role: "member" },
  });
  return user;
}

const memberRow = (userId: string) => ({
  table: "workspace_memberships",
  column: "userId",
  value: userId,
});

const catalog = (db: ConstructorParameters<typeof PrismaWorkspaceCatalogStore>[0]) =>
  new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));

const memoryStorage = (): FileStorage => {
  const objects = new Map<string, Blob>();
  return {
    put: async (key, file) => void objects.set(key, file),
    open: async (key) => {
      const body = objects.get(key);
      return body ? { body, contentType: body.type, sizeBytes: body.size } : null;
    },
    remove: async (key) => void objects.delete(key),
    head: async (key) => {
      const body = objects.get(key);
      return body ? { sizeBytes: body.size, contentType: body.type || null } : null;
    },
  };
};

defineEmitterCases([
  emitterCase({
    type: "workspace.member_removed",
    label: "removeMember",
    setup: (env, fixture) => addMember(env, fixture.workspace.id),
    act: (env, fixture, user) =>
      workspaceMemberDirectory(env.db).removeMember({
        workspaceId: fixture.workspace.id,
        actorUserId: fixture.owner.id,
        targetUserId: user.id,
      }),
    data: (_fixture, user) => ({ user_id: user.id }),
    refuse: (_fixture, user) => memberRow(user.id),
  }),
  emitterCase({
    type: "workspace.member_removed",
    label: "leave",
    setup: (env, fixture) => addMember(env, fixture.workspace.id),
    act: (env, fixture, user) =>
      workspaceMemberDirectory(env.db).leave({
        workspaceId: fixture.workspace.id,
        userId: user.id,
      }),
    data: (_fixture, user) => ({ user_id: user.id }),
    refuse: (_fixture, user) => memberRow(user.id),
  }),
  emitterCase({
    type: "workspace.member_role_changed",
    label: "updateRole",
    setup: (env, fixture) => addMember(env, fixture.workspace.id),
    act: (env, fixture, user) =>
      workspaceMemberDirectory(env.db).updateRole({
        workspaceId: fixture.workspace.id,
        actorUserId: fixture.owner.id,
        targetUserId: user.id,
        role: "admin",
      }),
    data: (_fixture, user) => ({ user_id: user.id, previous_role: "member", role: "admin" }),
    refuse: (_fixture, user) => memberRow(user.id),
  }),
  emitterCase({
    type: "workspace.config_updated",
    label: "rename",
    setup: async () => undefined,
    act: (env, fixture) => catalog(env.db).rename(fixture.workspace.id, "owner", "Renamed"),
    data: () => ({ fields: ["name"], name: "Renamed" }),
    refuse: (fixture) => ({ table: "workspaces", column: "id", value: fixture.workspace.id }),
  }),
  emitterCase({
    type: "workspace.config_updated",
    label: "changeSlug",
    setup: async (env, fixture) =>
      fixture.flag === "on" ? env.onSlug() : `emit-off-moved-${crypto.randomUUID().slice(0, 8)}`,
    act: (env, fixture, slug) => catalog(env.db).changeSlug(fixture.workspace.id, "owner", slug),
    data: (_fixture, slug) => ({ fields: ["slug"], slug }),
    refuse: (fixture) => ({ table: "workspaces", column: "id", value: fixture.workspace.id }),
  }),
  emitterCase({
    type: "workspace.config_updated",
    label: "icon upload",
    setup: async () => undefined,
    act: (env, fixture) =>
      new WorkspaceImages(env.db, async () => memoryStorage()).store(
        fixture.workspace.id,
        fixture.owner.id,
        new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], "icon.png", {
          type: "image/png",
        }),
      ),
    data: () => ({ fields: ["icon"] }),
    refuse: (fixture) => ({ table: "workspaces", column: "id", value: fixture.workspace.id }),
  }),
]);
