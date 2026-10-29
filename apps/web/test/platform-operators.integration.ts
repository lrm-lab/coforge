import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PlatformOperators,
  parseOperatorEntry,
  seedPlatformOperators,
} from "#src/server/app-marketplace/platform-operators.server";

/**
 * Platform operators against local PostgreSQL: the deployment seeds the first ones only when the
 * table is empty, only from an address the identity provider verified, and the review page's
 * add/remove keeps at least one. Skipped unless `DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.PLATFORM_OPERATOR_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const localDatabase =
  connectionString && ["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)
    ? connectionString
    : undefined;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: localDatabase! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const person = async (
    name: string,
    addresses: { email?: string; emailVerified?: boolean; phone?: string; phoneVerified?: boolean },
  ) => {
    const user = await db.user.create({
      data: {
        username: `${name}-${suffix}`,
        displayName: `${name}-${suffix}`,
        ...addresses,
      },
    });
    userIds.push(user.id);
    return user;
  };
  // Every seeded grant is global, so each test starts from an empty table and puts back nothing.
  const teardown = async () => {
    await db.platformOperator.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, suffix, person, teardown };
}

const problems: string[] = [];
const log = (message: string) => void problems.push(message);

test.skipIf(!localDatabase)(
  "the first boot grants the configured operators, and only verified addresses match",
  async () => {
    const { db, suffix, person, teardown } = await setup();
    try {
      await db.platformOperator.deleteMany({});
      const verified = await person("verified", {
        email: `boss-${suffix}@example.com`,
        emailVerified: true,
      });
      const unverified = await person("unverified", {
        email: `fake-${suffix}@example.com`,
        emailVerified: false,
      });

      const outcome = await seedPlatformOperators(
        db,
        `boss-${suffix}@example.com, fake-${suffix}@example.com, nonsense`,
        log,
      );

      expect(outcome.seeded).toBe(true);
      expect(outcome.granted).toBe(1);
      expect(outcome.unknown).toEqual([`fake-${suffix}@example.com`]);
      expect(problems).toHaveLength(1);
      const granted = await db.platformOperator.findMany({ select: { userId: true } });
      expect(granted).toEqual([{ userId: verified.id }]);
      expect(granted.some((row) => row.userId === unverified.id)).toBe(false);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!localDatabase)(
  "a boot with an operator already granted adds nobody, so a removal sticks",
  async () => {
    const { db, suffix, person, teardown } = await setup();
    try {
      await db.platformOperator.deleteMany({});
      const first = await person("first", {
        email: `first-${suffix}@example.com`,
        emailVerified: true,
      });
      const second = await person("second", {
        email: `second-${suffix}@example.com`,
        emailVerified: true,
      });
      await seedPlatformOperators(db, `first-${suffix}@example.com`, log);
      const again = await seedPlatformOperators(db, `second-${suffix}@example.com`, log);

      expect(again.seeded).toBe(false);
      expect(again.granted).toBe(0);
      expect(await db.platformOperator.findMany({ select: { userId: true } })).toEqual([
        { userId: first.id },
      ]);
      expect(second.id).not.toBe(first.id);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!localDatabase)("two boots at once grant one operator once", async () => {
  const { db, suffix, person, teardown } = await setup();
  try {
    await db.platformOperator.deleteMany({});
    await person("concurrent", {
      email: `concurrent-${suffix}@example.com`,
      emailVerified: true,
    });

    const outcomes = await Promise.all([
      seedPlatformOperators(db, `concurrent-${suffix}@example.com`, log),
      seedPlatformOperators(db, `concurrent-${suffix}@example.com`, log),
    ]);

    expect(outcomes.filter((outcome) => outcome.seeded)).toHaveLength(1);
    expect(await db.platformOperator.count()).toBe(1);
  } finally {
    await teardown();
  }
});

test.skipIf(!localDatabase)(
  "an operator adds and removes operators, and the last one cannot be removed",
  async () => {
    const { db, suffix, person, teardown } = await setup();
    try {
      await db.platformOperator.deleteMany({});
      const actor = await person("actor", {
        email: `actor-${suffix}@example.com`,
        emailVerified: true,
      });
      const peer = await person("peer", {
        phone: "+8613800138000",
        phoneVerified: true,
      });
      const unverified = await person("unverified", {
        email: `unverified-${suffix}@example.com`,
        emailVerified: false,
      });
      await seedPlatformOperators(db, `actor-${suffix}@example.com`, log);
      const operators = new PlatformOperators(db);

      // Only an operator may change the list.
      expect(await operators.grant(peer.id, parseOperatorEntry("13800138000")!)).toBe(
        "not_operator",
      );
      // An unverified address never matches, so it is refused like an unknown one.
      expect(
        await operators.grant(actor.id, parseOperatorEntry(`unverified-${suffix}@example.com`)!),
      ).toBe("no_user");
      expect(unverified.emailVerified).toBe(false);

      expect(await operators.grant(actor.id, parseOperatorEntry("13800138000")!)).toBe("granted");
      expect(await operators.grant(actor.id, parseOperatorEntry("+8613800138000")!)).toBe(
        "already",
      );
      const listed = (await operators.list(actor.id))!;
      expect(listed.map((row) => row.userId)).toEqual([actor.id, peer.id]);
      expect(listed[1]).toMatchObject({
        phone: "+8613800138000",
        phoneVerified: true,
        grantedByName: `actor-${suffix}`,
      });

      expect(await operators.revoke(actor.id, peer.id)).toBe("revoked");
      expect(await operators.revoke(actor.id, peer.id)).toBe("missing");
      expect(await operators.revoke(actor.id, actor.id)).toBe("last");
      expect((await operators.list(actor.id))!.map((row) => row.userId)).toEqual([actor.id]);
    } finally {
      await teardown();
    }
  },
);
