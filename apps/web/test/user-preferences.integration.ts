import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

test("a user who never saved a preference reads the defaults, and saving keeps the rest", async () => {
  const db = database();
  const user = await db.user.create({
    data: {
      displayName: `preferences-${crypto.randomUUID()}`,
      username: `preferences-${crypto.randomUUID()}`,
    },
  });
  try {
    const preferences = new UserPreferences(new PrismaUserPreferencesRepository(db));

    expect(await preferences.read(user.id)).toEqual({ timeZone: null, timeFormat: null });
    expect(await preferences.getBrowserNotificationsEnabled(user.id)).toBeFalse();

    expect(await preferences.set(user.id, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(await preferences.setBrowserNotificationsEnabled(user.id, true)).toBeTrue();
    // The retired column remains for compatibility, but its historical value is no longer read.
    await db.userPreference.update({
      where: { userId: user.id },
      data: { conversationOpenMode: "newest-unread" },
    });

    expect(await preferences.getBrowserNotificationsEnabled(user.id)).toBeTrue();
    expect(await preferences.read(user.id)).toEqual({
      timeZone: "Asia/Tokyo",
      timeFormat: null,
    });

    expect(await preferences.setTimeFormat(user.id, "24h")).toBe("24h");
    expect((await preferences.read(user.id)).timeFormat).toBe("24h");

    expect(await preferences.set(user.id, null)).toBeNull();
    expect(await preferences.read(user.id)).toEqual({ timeZone: null, timeFormat: "24h" });
  } finally {
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("preferences are removed with their user and legacy values stay constrained", async () => {
  const db = database();
  const user = await db.user.create({
    data: {
      displayName: `preferences-${crypto.randomUUID()}`,
      username: `preferences-${crypto.randomUUID()}`,
    },
  });
  try {
    const insert = (mode: string) =>
      db.$executeRaw`INSERT INTO "user_preferences" ("userId", "conversationOpenMode", "updatedAt")
        VALUES (${user.id}::uuid, ${mode}, now())`;
    await expect(Promise.resolve(insert("sideways"))).rejects.toThrow(
      "user_preferences_conversationOpenMode_check",
    );
    expect(await insert("newest-read")).toBe(1);
    await expect(
      Promise.resolve(
        db.$executeRaw`UPDATE "user_preferences" SET "timeFormat" = '25h' WHERE "userId" = ${user.id}::uuid`,
      ),
    ).rejects.toThrow("user_preferences_timeFormat_check");

    await new UserPreferences(new PrismaUserPreferencesRepository(db)).set(user.id, "UTC");
    await db.user.delete({ where: { id: user.id } });
    const [{ count }] = await db.$queryRaw<[{ count: bigint }]>`
      SELECT count(*) FROM "user_preferences" WHERE "userId" = ${user.id}::uuid`;
    expect(count).toBe(0n);
  } finally {
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
