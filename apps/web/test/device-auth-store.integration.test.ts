import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import {
  approveUserCode,
  authorizeDevice,
  pollDeviceToken,
} from "#src/server/auth/device-auth.server";
import { PrismaDeviceAuthorizationStore } from "#src/server/db/repositories/device-auth.repositories.server";

/**
 * The device-authorization store over local PostgreSQL: the conditional writes `updateMany`
 * performs are what single-use enforcement and expiry actually rest on, so they are exercised
 * against the real database rather than a stand-in.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

const environment = {
  COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  }),
  COFORGE_WORKER_JWT_KEY_ID: "test-key",
};

async function userFixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `device-auth-${suffix}`, username: `device-auth-${suffix}` },
  });
  return {
    user,
    async cleanup() {
      // Deleting the user cascades its device_authorizations rows.
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    },
  };
}

test.skipIf(!db)("two concurrent polls on an approved grant mint exactly one token", async () => {
  const store = new PrismaDeviceAuthorizationStore(db!);
  const f = await userFixture(db!);
  try {
    const start = Date.parse("2026-09-08T00:00:00Z");
    const grant = await authorizeDevice({
      store,
      origin: "https://example.test",
      now: () => start,
    });
    await approveUserCode({
      store,
      userCode: grant.userCode,
      userId: f.user.id,
      now: () => start + 1000,
    });

    // Five seconds apart so neither poll can be answered `slow_down` by the other's
    // markPolled, whatever order the two requests' reads land in.
    const [first, second] = await Promise.all([
      pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => start + 30_000,
        environment,
      }),
      pollDeviceToken({
        store,
        deviceCode: grant.deviceCode,
        now: () => start + 40_000,
        environment,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.status === "authorized")).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "error" && outcome.error === "invalid_grant"),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("approve, deny and consume are conditional on status and expiry", async () => {
  const store = new PrismaDeviceAuthorizationStore(db!);
  const f = await userFixture(db!);
  const suffix = crypto.randomUUID().slice(0, 8);
  try {
    const expired = await db!.deviceAuthorization.create({
      data: {
        deviceCodeHash: `device-${suffix}-expired`,
        userCodeHash: `user-${suffix}-expired`,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    // A grant already past its expiry is not approved or denied by a late write.
    expect(await store.approve(expired.id, f.user.id, new Date())).toBe(false);
    expect(await store.deny(expired.id, new Date())).toBe(false);

    const live = await db!.deviceAuthorization.create({
      data: {
        deviceCodeHash: `device-${suffix}-live`,
        userCodeHash: `user-${suffix}-live`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await store.approve(live.id, f.user.id, new Date())).toBe(true);
    // The first consume wins; a second one - the losing side of the poll race - does not.
    expect(await store.consume(live.id)).toBe(true);
    expect(await store.consume(live.id)).toBe(false);
    // And a settled grant cannot be denied back into another state.
    expect(await store.deny(live.id, new Date())).toBe(false);
  } finally {
    // The expired row never took a userId, so it does not cascade with the user.
    await db!.deviceAuthorization
      .deleteMany({ where: { userCodeHash: `user-${suffix}-expired` } })
      .catch(() => {});
    await f.cleanup();
  }
});
