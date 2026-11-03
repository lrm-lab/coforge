import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { NotificationSettingsStore } from "#src/server/notifications/notification-settings.server";
import { DEFAULT_NOTIFICATION_SETTINGS } from "#src/server/notifications/notification-rules.server";

/**
 * A person's account notification settings (task #467) against local PostgreSQL: the defaults
 * with no row, a save that names its version, a stale save refused with the current version, and
 * the bounds a save must keep. Skipped unless `CHANNEL_TEST_DATABASE_URL` points at it.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

async function person(db: PrismaClient, timeZone?: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: {
      displayName: `n-${suffix}`,
      username: `n-${suffix}`,
      ...(timeZone && { preferences: { create: { timeZone } } }),
    },
  });
  return { id: user.id, cleanup: () => db.user.delete({ where: { id: user.id } }).catch(() => {}) };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const NOW = new Date("2026-11-03T10:00:00Z");

test.skipIf(!db)("no row reads as the defaults, with the person's time zone", async () => {
  const someone = await person(db!, "Asia/Shanghai");
  const nobody = await person(db!);
  try {
    const store = new NotificationSettingsStore(db!);
    expect(await store.read(someone.id)).toEqual({
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      timeZone: "Asia/Shanghai",
      language: null,
    });
    expect((await store.read(nobody.id)).timeZone).toBe("UTC");
    const many = await store.readMany([someone.id, nobody.id]);
    expect(many.get(someone.id)).toEqual({
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      timeZone: "Asia/Shanghai",
      language: null,
    });
    expect(many.get(nobody.id)?.timeZone).toBe("UTC");
  } finally {
    await someone.cleanup();
    await nobody.cleanup();
  }
});

test.skipIf(!db)("a save changes only what it names and moves the version by one", async () => {
  const someone = await person(db!);
  try {
    const store = new NotificationSettingsStore(db!);
    const first = await store.update(
      someone.id,
      { expectedVersion: 0, changes: { previewMode: "sender", sound: false } },
      NOW,
    );
    expect(first).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      previewMode: "sender",
      sound: false,
      version: 1,
    });
    const second = await store.update(
      someone.id,
      {
        expectedVersion: 1,
        changes: {
          pausedUntil: "2026-11-03T11:00:00.000Z",
          quietHours: { enabled: true, startMinute: 23 * 60, endMinute: 7 * 60 },
          mobileDelay: "idle_5m",
        },
      },
      NOW,
    );
    expect(second).toEqual({
      pausedUntil: new Date("2026-11-03T11:00:00Z"),
      quietHours: { enabled: true, startMinute: 23 * 60, endMinute: 7 * 60 },
      previewMode: "sender",
      sound: false,
      mobileDelay: "idle_5m",
      version: 2,
    });
    // Ending a pause is a save too.
    const resumed = await store.update(
      someone.id,
      { expectedVersion: 2, changes: { pausedUntil: null } },
      NOW,
    );
    expect(resumed).toMatchObject({ pausedUntil: null, version: 3 });
    expect((await store.read(someone.id)).settings).toEqual(resumed);
  } finally {
    await someone.cleanup();
  }
});

test.skipIf(!db)(
  "a save from an older version is refused and names the current version",
  async () => {
    const someone = await person(db!);
    try {
      const store = new NotificationSettingsStore(db!);
      await store.update(someone.id, { expectedVersion: 0, changes: { sound: false } }, NOW);
      for (const expectedVersion of [0, 2]) {
        const error = await refusal(
          store.update(someone.id, { expectedVersion, changes: { sound: true } }, NOW),
        );
        expect(error.code).toBe("CONFLICT");
        expect(error.errorId).toBe("notification-settings-version-conflict");
        expect(error.details).toEqual({ currentVersion: 1 });
      }
      // Two first saves at once: one wins, the other is a conflict, never a duplicate row.
      const fresh = await person(db!);
      try {
        const outcomes = await Promise.allSettled([
          store.update(fresh.id, { expectedVersion: 0, changes: { sound: false } }, NOW),
          store.update(fresh.id, { expectedVersion: 0, changes: { previewMode: "hidden" } }, NOW),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        expect(isAppError(rejected?.reason) && rejected.reason.code).toBe("CONFLICT");
        expect((await store.read(fresh.id)).settings.version).toBe(1);
      } finally {
        await fresh.cleanup();
      }
    } finally {
      await someone.cleanup();
    }
  },
);

test.skipIf(!db)("a pause ends within a year", async () => {
  const someone = await person(db!);
  try {
    const store = new NotificationSettingsStore(db!);
    const error = await refusal(
      store.update(
        someone.id,
        { expectedVersion: 0, changes: { pausedUntil: "2027-11-05T10:00:00.000Z" } },
        NOW,
      ),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.errorId).toBe("notification-pause-too-long");
    expect((await store.read(someone.id)).settings.version).toBe(0);
  } finally {
    await someone.cleanup();
  }
});
