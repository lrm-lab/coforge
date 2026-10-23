import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import {
  createAppEditorSave,
  createAppPermissions,
} from "#src/server/app-permissions/app-permissions-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * An app's data permissions against local PostgreSQL with migrations applied: what its Workspace's
 * owners and admins declare in the editor, what an installation's approval records, and that none
 * of it is reachable while `app-data-permissions` is off for the Workspace.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

/** The flag file turns `app-data-permissions` on for these slugs only. */
const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 16 }, (_, index) => `perm-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-permissions-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-data-permissions": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
          targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
  await db?.$disconnect();
});

/** A Workspace with an owner, an admin and a member, its app registered by the owner, and the flag
 * on for it unless `flag` is `off`; `cleanup` removes all of it. */
async function fixture(db: PrismaClient, { flag = "on" }: { flag?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = flag === "on" ? ON_SLUGS[nextOnSlug++]! : `perm-off-${suffix}`;
  const person = (role: string) => ({
    displayName: `perm-${role}-${suffix}`,
    username: `perm-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Permissions",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  const actor = (role: keyof typeof people) => ({
    workspaceId: workspace.id,
    actorUserId: people[role].id,
  });
  const key = `perm-${suffix}`;
  const registration: AppRegistrationInput = {
    key,
    name: "Acme Insights",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "data-analytics",
    allowedScopes: ["openid", "profile", "identity"],
  };
  await createAppRegistry(db).registerApp(actor("owner"), registration);
  return {
    key,
    people,
    actor,
    /** The app's and its installation's permission columns as stored. */
    async stored() {
      const app = await db.app.findUniqueOrThrow({
        where: { key },
        select: {
          permissionGroups: true,
          permissionRevision: true,
          installations: {
            select: {
              approvedGroups: true,
              approvedRevision: true,
              approvedAt: true,
              approvedByUserId: true,
            },
          },
        },
      });
      const [installation] = app.installations;
      return {
        permissionGroups: app.permissionGroups,
        permissionRevision: app.permissionRevision,
        installation: installation!,
      };
    },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

/** The refusal `promise` ends in, as `code` and `errorId`. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, errorId: error.errorId };
    throw error;
  }
  throw new Error("expected a refusal");
}

test.skipIf(!db)(
  "declaring sets the app's groups and bumps its revision only when the set changes",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    try {
      expect(await app.stored()).toMatchObject({ permissionGroups: [], permissionRevision: 0 });

      const declared = await permissions.declare(app.actor("admin"), app.key, [
        "agent",
        "workspace",
      ]);
      expect(declared).toMatchObject({ declared: ["workspace", "agent"], revision: 1 });
      expect(await app.stored()).toMatchObject({
        permissionGroups: ["workspace", "agent"],
        permissionRevision: 1,
      });

      // The same set, in another order and repeated, is no change.
      await permissions.declare(app.actor("owner"), app.key, ["workspace", "agent", "agent"]);
      expect((await app.stored()).permissionRevision).toBe(1);

      await permissions.declare(app.actor("owner"), app.key, ["workspace"]);
      expect(await app.stored()).toMatchObject({
        permissionGroups: ["workspace"],
        permissionRevision: 2,
      });
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a group outside the four is refused, by the module and by the database",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    try {
      expect(
        await refusal(permissions.declare(app.actor("owner"), app.key, ["workspace", "messages"])),
      ).toEqual({ code: "INVALID_INPUT", errorId: "app-permission-groups-invalid" });
      expect(await app.stored()).toMatchObject({ permissionGroups: [], permissionRevision: 0 });

      // A Prisma query runs only once awaited, so each is settled before it is judged.
      const settled = (query: PromiseLike<unknown>) =>
        Promise.resolve(query).then(
          () => "stored",
          (error: unknown) => String(error),
        );
      expect(
        await settled(
          db!.app.update({ where: { key: app.key }, data: { permissionGroups: ["messages"] } }),
        ),
      ).toContain("apps_permission_groups_check");
      expect(
        await settled(
          db!.appInstallation.updateMany({
            where: { app: { key: app.key } },
            data: { approvedGroups: ["agent_reminder_write"] },
          }),
        ),
      ).toContain("app_installations_approved_groups_check");
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a declared group waits for approval; the effective groups are the approved ones still declared",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    try {
      await permissions.declare(app.actor("owner"), app.key, ["workspace", "agent"]);
      const listed = await permissions.workspacePermissions(app.actor("member"));
      expect(listed?.apps.get(app.key)).toMatchObject({
        declared: ["workspace", "agent"],
        approved: [],
        effective: [],
        pending: ["workspace", "agent"],
      });

      await permissions.approve(app.actor("admin"), app.key, 1);
      const declared = await permissions.declare(app.actor("owner"), app.key, [
        "workspace",
        "agent",
        "channel",
      ]);
      expect(declared).toMatchObject({
        revision: 2,
        approved: ["workspace", "agent"],
        approvedRevision: 1,
        effective: ["workspace", "agent"],
        pending: ["channel"],
      });
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)(
  "removing a declared group takes effect at once, and adding it back needs approval again",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    try {
      await permissions.declare(app.actor("owner"), app.key, ["workspace", "computer"]);
      await permissions.approve(app.actor("owner"), app.key, 1);

      const narrowed = await permissions.declare(app.actor("owner"), app.key, ["workspace"]);
      expect(narrowed).toMatchObject({ effective: ["workspace"], pending: [] });

      const widened = await permissions.declare(app.actor("owner"), app.key, [
        "workspace",
        "computer",
      ]);
      expect(widened).toMatchObject({ effective: ["workspace"], pending: ["computer"] });
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)(
  "approving the current revision records the approver, the time and the revision",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    try {
      await permissions.declare(app.actor("owner"), app.key, ["channel"]);
      const before = Date.now();
      const approved = await permissions.approve(app.actor("admin"), app.key, 1);
      expect(approved).toMatchObject({
        approved: ["channel"],
        approvedRevision: 1,
        effective: ["channel"],
        pending: [],
      });
      const { installation } = await app.stored();
      expect(installation).toMatchObject({
        approvedGroups: ["channel"],
        approvedRevision: 1,
        approvedByUserId: app.people.admin.id,
      });
      expect(installation.approvedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

      // The approver's account going leaves the approval, without its approver.
      await db!.user.delete({ where: { id: app.people.admin.id } });
      expect((await app.stored()).installation).toMatchObject({
        approvedGroups: ["channel"],
        approvedByUserId: null,
      });
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)("approving a revision that is no longer current is refused", async () => {
  const app = await fixture(db!);
  const permissions = createAppPermissions(db!);
  try {
    await permissions.declare(app.actor("owner"), app.key, ["agent"]);
    await permissions.declare(app.actor("owner"), app.key, ["agent", "channel"]);
    expect(await refusal(permissions.approve(app.actor("admin"), app.key, 1))).toEqual({
      code: "CONFLICT",
      errorId: "app-permissions-changed",
    });
    expect((await app.stored()).installation).toMatchObject({
      approvedGroups: [],
      approvedRevision: 0,
      approvedAt: null,
      approvedByUserId: null,
    });
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("a member can neither declare nor approve", async () => {
  const app = await fixture(db!);
  const permissions = createAppPermissions(db!);
  try {
    expect(await refusal(permissions.declare(app.actor("member"), app.key, ["agent"]))).toEqual({
      code: "ACCESS_DENIED",
      errorId: undefined,
    });
    await permissions.declare(app.actor("owner"), app.key, ["agent"]);
    expect(await refusal(permissions.approve(app.actor("member"), app.key, 1))).toEqual({
      code: "ACCESS_DENIED",
      errorId: undefined,
    });
    expect(await app.stored()).toMatchObject({
      permissionGroups: ["agent"],
      permissionRevision: 1,
      installation: { approvedGroups: [], approvedRevision: 0 },
    });
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)(
  "with the flag off, permissions are neither shown nor changed, and saving an app keeps them",
  async () => {
    const app = await fixture(db!, { flag: "off" });
    const permissions = createAppPermissions(db!);
    try {
      // As a Workspace that had the flag on would have left them.
      await db!.app.update({
        where: { key: app.key },
        data: { permissionGroups: ["workspace"], permissionRevision: 3 },
      });
      const off = { code: "ACCESS_DENIED", errorId: "app-data-permissions-off" } as const;
      expect(await permissions.workspacePermissions(app.actor("owner"))).toBeNull();
      expect(await refusal(permissions.declare(app.actor("owner"), app.key, ["agent"]))).toEqual(
        off,
      );
      expect(await refusal(permissions.approve(app.actor("owner"), app.key, 3))).toEqual(off);

      await createAppRegistry(db!).updateApp(app.actor("owner"), app.key, {
        name: "Acme Insights 2",
        description: "Renamed.",
      });
      expect(await app.stored()).toMatchObject({
        permissionGroups: ["workspace"],
        permissionRevision: 3,
        installation: { approvedGroups: [], approvedRevision: 0, approvedAt: null },
      });
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)(
  "saving the editor is one change: a refused profile patch leaves the declaration and approvals as they were",
  async () => {
    const app = await fixture(db!);
    const permissions = createAppPermissions(db!);
    const editor = createAppEditorSave(db!);
    try {
      await permissions.declare(app.actor("owner"), app.key, ["workspace", "computer"]);
      await permissions.approve(app.actor("owner"), app.key, 1);
      const before = await app.stored();

      // The groups would narrow the approval; the patch is what is refused.
      expect(
        await refusal(
          editor.save(app.actor("owner"), app.key, {
            patch: { name: "" },
            permissionGroups: ["workspace"],
          }),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(await app.stored()).toEqual(before);

      // Groups that are refused leave the profile as it was.
      expect(
        await refusal(
          editor.save(app.actor("owner"), app.key, {
            patch: { description: "Changed." },
            permissionGroups: ["messages"],
          }),
        ),
      ).toEqual({ code: "INVALID_INPUT", errorId: "app-permission-groups-invalid" });
      expect((await db!.app.findUniqueOrThrow({ where: { key: app.key } })).description).toBe("");

      // Both valid: both written, and the narrowing with them.
      const saved = await editor.save(app.actor("owner"), app.key, {
        patch: { description: "Changed." },
        permissionGroups: ["workspace"],
      });
      expect(saved.app.description).toBe("Changed.");
      expect(saved.permissions).toMatchObject({ declared: ["workspace"], revision: 2 });
      expect(await app.stored()).toMatchObject({
        permissionGroups: ["workspace"],
        permissionRevision: 2,
        installation: { approvedGroups: ["workspace"] },
      });

      // Without groups, only the profile changes.
      const renamed = await editor.save(app.actor("admin"), app.key, {
        patch: { name: "Renamed" },
      });
      expect(renamed.permissions).toMatchObject({ declared: ["workspace"], revision: 2 });
    } finally {
      await app.cleanup();
    }
  },
);
