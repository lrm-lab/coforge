import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { APP_NOTIFICATION_EVENT_NAMES } from "#src/features/apps/app-notification-events";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { subscribersOf } from "#src/server/app-notifications/subscribers.server";
import {
  createAppEditorSave,
  createAppPermissions,
} from "#src/server/app-permissions/app-permissions-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * The notification events an app subscribes to against local PostgreSQL with migrations applied:
 * declared with the data groups (one revision), approved with them by an installation, narrowed at
 * once when dropped, and what `subscribersOf` delivers an event to (effective events only).
 *
 * Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL; `DATABASE_URL`
 * must name the same database, which `subscribersOf` reads.
 */
const connectionString = Bun.env.APP_NOTIFICATIONS_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
/** Both flags on. */
const BOTH = Array.from({ length: 16 }, (_, index) => `sub-both-${RUN}-${index}`);
/** Only `app-data-permissions` on. */
const PERMISSIONS_ONLY = Array.from({ length: 4 }, (_, index) => `sub-perm-${RUN}-${index}`);
/** Only `app-notifications` on. */
const NOTIFICATIONS_ONLY = Array.from({ length: 4 }, (_, index) => `sub-note-${RUN}-${index}`);
const next = { both: 0, permissionsOnly: 0, notificationsOnly: 0 };
let flagDirectory: string | undefined;

const flag = (slugs: string[]) => ({
  state: "ENABLED",
  variants: { on: true, off: false },
  defaultVariant: "off",
  targeting: { if: [{ in: [{ var: "workspaceSlug" }, slugs] }, "on", "off"] },
});

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-subscriptions-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-data-permissions": flag([...BOTH, ...PERMISSIONS_ONLY]),
        "app-notifications": flag([...BOTH, ...NOTIFICATIONS_ONLY]),
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

type Flags = "both" | "permissionsOnly" | "notificationsOnly";
const SLUGS: Record<Flags, string[]> = {
  both: BOTH,
  permissionsOnly: PERMISSIONS_ONLY,
  notificationsOnly: NOTIFICATIONS_ONLY,
};

/** A Workspace with an owner, whose app is registered (hence installed) in it and has an enabled
 * webhook. */
async function fixture(db: PrismaClient, flags: Flags = "both") {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `sub-${suffix}`, username: `sub-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: SLUGS[flags][next[flags]++]!,
      name: "Subscriptions",
      members: { create: [{ userId: owner.id, role: "owner" }] },
    },
  });
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  const key = `sub-${suffix}`;
  await createAppRegistry(db).registerApp(actor, {
    key,
    name: "Acme Subscribed",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "other",
    allowedScopes: ["openid", "profile", "identity"],
  });
  const app = await db.app.findUniqueOrThrow({ where: { key }, select: { id: true } });
  await db.appWebhook.create({
    data: {
      appId: app.id,
      enabled: true,
      endpointUrl: "https://hooks.example/in",
      secretGeneration: 1,
    },
  });
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id },
    select: { id: true },
  });
  return {
    workspace,
    actor,
    key,
    installationId: installation.id,
    permissions: createAppPermissions(db),
    stored: () =>
      db.app.findUniqueOrThrow({
        where: { key },
        select: {
          permissionRevision: true,
          notificationEvents: true,
          installations: { select: { approvedEvents: true, approvedGroups: true } },
        },
      }),
    /** The installations an event of `type` is delivered to. */
    delivered: async (type: "workspace.member_added") =>
      (
        await subscribersOf(
          newAppNotificationEvent({
            type,
            workspaceId: workspace.id,
            data: { user_id: crypto.randomUUID(), role: "member" },
          }),
        )
      ).map((subscriber) => subscriber.installationId),
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, errorId: error.errorId };
    throw error;
  }
  throw new Error("expected a refusal");
}

const testWithDatabase = db ? test : test.skip;

testWithDatabase(
  "events are declared with the groups, in one revision, and need the groups they name",
  async () => {
    const app = await fixture(db!);
    try {
      const declared = await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "channel"],
        ["channel.archived", "workspace.public_channel_created"],
      );
      expect(declared).toMatchObject({
        revision: 1,
        events: ["workspace.public_channel_created", "channel.archived"],
        effectiveEvents: [],
        pendingEvents: ["workspace.public_channel_created", "channel.archived"],
      });
      // The same groups with other events is a new revision; the same of both is not.
      await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "channel"],
        ["channel.archived"],
      );
      await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "channel"],
        ["channel.archived"],
      );
      expect((await app.stored()).permissionRevision).toBe(2);

      const invalid = {
        code: "INVALID_INPUT",
        errorId: "app-notification-events-invalid",
      } as const;
      expect(
        await refusal(
          app.permissions.declare(app.actor, app.key, ["workspace"], ["agent.status_changed"]),
        ),
      ).toEqual(invalid);
      expect(
        await refusal(
          app.permissions.declare(app.actor, app.key, ["workspace"], ["server.member_added"]),
        ),
      ).toEqual(invalid);
      expect(
        await refusal(
          app.permissions.declare(
            app.actor,
            app.key,
            ["channel"],
            ["workspace.public_channel_created"],
          ),
        ),
      ).toEqual(invalid);
      expect(await app.stored()).toMatchObject({
        permissionRevision: 2,
        notificationEvents: ["channel.archived"],
      });
    } finally {
      await app.cleanup();
    }
  },
);

testWithDatabase("declaring events is refused where app-notifications is off", async () => {
  const app = await fixture(db!, "permissionsOnly");
  try {
    expect(
      await refusal(
        app.permissions.declare(app.actor, app.key, ["workspace"], ["workspace.member_added"]),
      ),
    ).toEqual({ code: "ACCESS_DENIED", errorId: "app-notifications-off" });
    // Groups alone still work, and show no events.
    expect(await app.permissions.declare(app.actor, app.key, ["workspace"])).toMatchObject({
      declared: ["workspace"],
      events: [],
    });
  } finally {
    await app.cleanup();
  }
});

testWithDatabase(
  "an approval covers events with groups; dropping an event or its group takes effect at once",
  async () => {
    const app = await fixture(db!);
    try {
      await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "agent"],
        ["workspace.member_added", "agent.profile_updated"],
      );
      const approved = await app.permissions.approve(app.actor, app.key, 1);
      expect(approved).toMatchObject({
        effectiveEvents: ["workspace.member_added", "agent.profile_updated"],
        pendingEvents: [],
      });
      expect((await app.stored()).installations[0]).toMatchObject({
        approvedEvents: ["workspace.member_added", "agent.profile_updated"],
      });

      // A new event waits for approval, like a new group; the approved ones keep running.
      const widened = await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "agent"],
        ["workspace.member_added", "workspace.member_removed", "agent.profile_updated"],
      );
      expect(widened).toMatchObject({
        revision: 2,
        effectiveEvents: ["workspace.member_added", "agent.profile_updated"],
        pendingEvents: ["workspace.member_removed"],
      });

      // Dropping an event narrows the approval with no approval of its own.
      const narrowed = await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace", "agent"],
        ["workspace.member_added"],
      );
      expect(narrowed).toMatchObject({
        effectiveEvents: ["workspace.member_added"],
        pendingEvents: [],
      });
      expect((await app.stored()).installations[0]?.approvedEvents).toEqual([
        "workspace.member_added",
      ]);

      // Dropping a group takes the events that need it with it, without being asked.
      await app.permissions.declare(app.actor, app.key, ["agent"]);
      expect(await app.stored()).toMatchObject({
        notificationEvents: [],
        installations: [{ approvedGroups: ["agent"], approvedEvents: [] }],
      });
    } finally {
      await app.cleanup();
    }
  },
);

testWithDatabase(
  "the editor's Save declares the events with the groups in one change",
  async () => {
    const app = await fixture(db!);
    try {
      const save = createAppEditorSave(db!);
      await save.save(app.actor, app.key, {
        patch: { name: "Renamed" },
        permissionGroups: ["workspace"],
        notificationEvents: ["workspace.member_added"],
      });
      await expect(
        save.save(app.actor, app.key, {
          patch: { name: "Never" },
          permissionGroups: ["workspace"],
          notificationEvents: ["agent.status_changed"],
        }),
      ).rejects.toMatchObject({ errorId: "app-notification-events-invalid" });
      expect(await app.stored()).toMatchObject({
        permissionRevision: 1,
        notificationEvents: ["workspace.member_added"],
      });
      expect((await db!.app.findUniqueOrThrow({ where: { key: app.key } })).name).toBe("Renamed");
    } finally {
      await app.cleanup();
    }
  },
);

testWithDatabase(
  "an event is delivered only to installations with it among their effective events",
  async () => {
    const app = await fixture(db!);
    try {
      // Nothing subscribed: an enabled webhook alone receives nothing.
      expect(await app.delivered("workspace.member_added")).toEqual([]);

      await app.permissions.declare(app.actor, app.key, ["workspace"], ["workspace.member_added"]);
      // Subscribed but not approved.
      expect(await app.delivered("workspace.member_added")).toEqual([]);

      await app.permissions.approve(app.actor, app.key, 1);
      expect(await app.delivered("workspace.member_added")).toEqual([app.installationId]);

      // Another event subscribed and approved leaves this one as it was.
      await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace"],
        ["workspace.member_removed"],
      );
      expect(await app.delivered("workspace.member_added")).toEqual([]);

      // The group is approved but the event is not: the event waits for approval.
      await app.permissions.declare(
        app.actor,
        app.key,
        ["workspace"],
        ["workspace.member_added", "workspace.member_removed"],
      );
      expect(await app.delivered("workspace.member_added")).toEqual([]);
      await app.permissions.approve(app.actor, app.key, 3);
      expect(await app.delivered("workspace.member_added")).toEqual([app.installationId]);

      // The approved group is no longer declared: the event stops.
      await db!.appInstallation.update({
        where: { id: app.installationId },
        data: { approvedGroups: [] },
      });
      expect(await app.delivered("workspace.member_added")).toEqual([]);
    } finally {
      await app.cleanup();
    }
  },
);

testWithDatabase("with app-data-permissions off nothing is delivered", async () => {
  const app = await fixture(db!, "notificationsOnly");
  try {
    await db!.app.update({
      where: { key: app.key },
      data: { permissionGroups: ["workspace"], notificationEvents: ["workspace.member_added"] },
    });
    await db!.appInstallation.update({
      where: { id: app.installationId },
      data: { approvedGroups: ["workspace"], approvedEvents: ["workspace.member_added"] },
    });
    expect(await app.delivered("workspace.member_added")).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

testWithDatabase("the database admits the catalog's events and nothing else", async () => {
  const app = await fixture(db!);
  try {
    await db!.app.update({
      where: { key: app.key },
      data: { notificationEvents: [...APP_NOTIFICATION_EVENT_NAMES] },
    });
    await db!.appInstallation.update({
      where: { id: app.installationId },
      data: { approvedEvents: [...APP_NOTIFICATION_EVENT_NAMES] },
    });
    await expect(
      Promise.resolve().then(() =>
        db!.app.update({
          where: { key: app.key },
          data: { notificationEvents: ["server.member_added"] },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        db!.appInstallation.update({
          where: { id: app.installationId },
          data: { approvedEvents: ["thread.resolved"] },
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await app.cleanup();
  }
});
