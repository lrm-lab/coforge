import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  APP_NOTIFICATION_EVENT_NAMES,
  type AppNotificationEventName,
} from "#src/features/apps/app-notification-events";
import { PrismaClient } from "#src/generated/prisma/client";
import type { AppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { APP_NOTIFICATION_EVENT_QUEUE } from "#src/server/app-notifications/app-notification-jobs";
import {
  startAppNotificationQueue,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { subscribeTo } from "./app-notification-subscription";

/**
 * What the emitter suites share: a real PostgreSQL (`APP_NOTIFICATIONS_TEST_DATABASE_URL`, which
 * also needs `DATABASE_URL` to name it), the pg-boss queue on it, and the `app-notifications` flags
 * on for the Workspaces of `emitterFixture` unless asked otherwise. A suite calls
 * `startEmitterEnvironment` in `beforeAll` and `stop` in `afterAll`.
 */
export const emitterDatabaseUrl = Bun.env.APP_NOTIFICATIONS_TEST_DATABASE_URL;

/** A flagd definition that turns a flag on for the Workspaces whose slug starts with `prefix`. */
const flagOnFor = (prefix: string) => ({
  state: "ENABLED",
  variants: { on: true, off: false },
  defaultVariant: "off",
  targeting: { if: [{ starts_with: [{ var: "workspaceSlug" }, prefix] }, "on", "off"] },
});

/** The write whose commit a test refuses: see `refuseCommit`. */
export type RefusedCommit =
  | { table: string; column: string; value: string }
  | { table: string; updateWhen: string };

export type EmitterEnvironment = Awaited<ReturnType<typeof startEmitterEnvironment>>;

export async function startEmitterEnvironment() {
  const connectionString = emitterDatabaseUrl!;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const run = crypto.randomUUID().slice(0, 8);
  const onPrefix = `emit-on-${run}-`;
  const directory = await mkdtemp(join(tmpdir(), "coforge-app-notification-emitters-"));
  const path = join(directory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-notifications": flagOnFor(onPrefix),
        "app-data-permissions": flagOnFor(onPrefix),
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
  const boss = await startAppNotificationQueue(connectionString);
  let nextOnSlug = 0;
  const onSlug = () => `${onPrefix}${nextOnSlug++}`;

  /** A Workspace with an owner and an app installed in it that subscribes to every event, with an
   * enabled webhook. The flag is on for it unless `flag` is `off`. */
  async function fixture({ flag = "on" }: { flag?: "on" | "off" } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({
      data: { displayName: `emit-${suffix}`, username: `emit-${suffix}` },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: flag === "on" ? onSlug() : `emit-off-${suffix}`,
        name: "Emitters",
        members: { create: [{ userId: owner.id, role: "owner" }] },
      },
    });
    await createAppRegistry(db).registerApp(
      { workspaceId: workspace.id, actorUserId: owner.id },
      {
        key: `emit-${suffix}`,
        name: "Acme Emitted",
        description: "",
        whenToUse: "",
        homepageUrl: null,
        redirectUris: [],
        category: "other",
        allowedScopes: ["openid", "profile", "identity"],
      },
    );
    const { appId } = await db.appInstallation.findFirstOrThrow({
      where: { workspaceId: workspace.id },
      select: { appId: true },
    });
    await subscribeTo(db, appId, APP_NOTIFICATION_EVENT_NAMES);
    await db.appWebhook.create({
      data: { appId, enabled: true, endpointUrl: "https://hooks.example/in", secretGeneration: 1 },
    });
    return {
      workspace,
      owner,
      flag,
      async cleanup() {
        await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
        await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
      },
    };
  }

  /** The recorded events of `type` for a Workspace, in the order they were recorded. */
  async function recorded(
    workspaceId: string,
    type: AppNotificationEventName,
  ): Promise<AppNotificationEvent[]> {
    const jobs = await boss.findJobs(APP_NOTIFICATION_EVENT_QUEUE, { data: { workspaceId, type } });
    return jobs.map((job) => job.data as AppNotificationEvent);
  }

  /**
   * Makes the commit of any transaction that writes the row refused, so the whole transaction rolls
   * back after every statement in it, an event job included, has run. The row is the one whose
   * `column` holds `value`, or, with `updateWhen` (an SQL condition over `NEW`), the updates that
   * satisfy it. The returned function removes the guard.
   */
  async function refuseCommit(guard: RefusedCommit) {
    const name = `emit_refuse_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION emit_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_NARGS = 0 OR (CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END ->> TG_ARGV[0]) = TG_ARGV[1]
        THEN RAISE EXCEPTION 'commit refused'; END IF;
        RETURN NULL;
      END $$`);
    await db.$executeRawUnsafe(
      "updateWhen" in guard
        ? `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON "${guard.table}"
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (${guard.updateWhen})
           EXECUTE FUNCTION emit_refuse_commit()`
        : `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT OR UPDATE OR DELETE ON "${guard.table}"
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
           EXECUTE FUNCTION emit_refuse_commit('${guard.column}', '${guard.value}')`,
    );
    return () => db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "${guard.table}"`);
  }

  return {
    db,
    fixture,
    recorded,
    refuseCommit,
    /** A slug the flag is on for, which no Workspace has yet. */
    onSlug,
    async stop() {
      await stopAppNotificationQueue();
      await installFeatureFlags({ status: "disabled" });
      await rm(directory, { recursive: true, force: true });
      await db.$disconnect();
    },
  };
}
