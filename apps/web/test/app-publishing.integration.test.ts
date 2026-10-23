import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { grantPlatformOperator } from "#src/server/app-marketplace/platform-operators.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { PrismaAppPublishingStore } from "#src/server/db/repositories/app-publishing.repositories.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * Marketplace review against local PostgreSQL with migrations applied: the publish, withdraw and
 * unpublish requests of an app's owners and admins, a platform operator's decisions, and that
 * none of it is reachable while `app-marketplace` is off for the Workspace.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 16 }, (_, index) => `mkt-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-marketplace-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-marketplace": {
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

/** A Workspace with an owner, an admin, a member and a member who is a platform operator, an app
 * registered by the owner, and the flag on unless `flag` is `off`. */
async function fixture(db: PrismaClient, { flag = "on" }: { flag?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = flag === "on" ? ON_SLUGS[nextOnSlug++]! : `mkt-off-${suffix}`;
  const person = (name: string) => ({
    displayName: `mkt-${name}-${suffix}`,
    username: `mkt-${name}-${suffix}`,
  });
  const roles = { owner: "owner", admin: "admin", member: "member", reviewer: "member" };
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
    reviewer: await db.user.create({ data: person("reviewer") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Marketplace",
      members: {
        create: Object.entries(people).map(([name, user]) => ({
          userId: user.id,
          role: roles[name as keyof typeof roles],
        })),
      },
    },
  });
  const actor = (role: keyof typeof people) => ({
    workspaceId: workspace.id,
    actorUserId: people[role].id,
  });
  const key = `mkt-${suffix}`;
  const registration: AppRegistrationInput = {
    key,
    name: "Acme Insights",
    description: "Reads things",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "data-analytics",
    allowedScopes: ["openid", "profile", "identity"],
  };
  await createAppRegistry(db).registerApp(actor("owner"), registration);
  await db.platformOperator.create({
    data: { userId: people.reviewer.id, role: "app_reviewer" },
  });
  const stored = () =>
    db.app.findUniqueOrThrow({
      where: { key },
      select: {
        publishStatus: true,
        publishedAt: true,
        reviewRequests: { orderBy: { requestedAt: "asc" } },
      },
    });
  return {
    key,
    slug,
    people,
    actor,
    stored,
    /** The id of the app's pending request. */
    async pendingId() {
      const [request] = (await stored()).reviewRequests.filter((r) => r.outcome === null);
      return request!.id;
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

test.skipIf(!db)("a publish request is idempotent and leaves one pending request", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    expect(await publishing.requestPublish(app.actor("owner"), app.key)).toBe("publish_requested");
    expect(await publishing.requestPublish(app.actor("admin"), app.key)).toBe("publish_requested");
    const stored = await app.stored();
    expect(stored.publishStatus).toBe("publish_requested");
    expect(stored.reviewRequests).toHaveLength(1);
    expect(stored.reviewRequests[0]).toMatchObject({ kind: "publish", outcome: null });

    // Concurrent repeats still file exactly one.
    await Promise.all([
      publishing.requestPublish(app.actor("owner"), app.key),
      publishing.requestPublish(app.actor("owner"), app.key),
    ]);
    expect((await app.stored()).reviewRequests).toHaveLength(1);

    // A request of the other kind while one is pending is refused.
    expect(await refusal(publishing.requestUnpublish(app.actor("owner"), app.key))).toEqual({
      code: "CONFLICT",
      errorId: "app-publish-status-conflict",
    });
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("a publish request needs the app to have a description", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    await db!.app.update({ where: { key: app.key }, data: { description: "  " } });
    expect(await refusal(publishing.requestPublish(app.actor("owner"), app.key))).toEqual({
      code: "INVALID_INPUT",
      errorId: "app-description-required",
    });
    expect(await app.stored()).toMatchObject({ publishStatus: "private", reviewRequests: [] });
    await db!.app.update({ where: { key: app.key }, data: { description: "Reads things" } });
    expect(await publishing.requestPublish(app.actor("owner"), app.key)).toBe("publish_requested");
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("withdrawing returns the app to private and removes the request", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    // Nothing to withdraw: the answer is the state it is already in.
    expect(await publishing.withdrawPublish(app.actor("owner"), app.key)).toBe("private");
    await publishing.requestPublish(app.actor("owner"), app.key);
    expect(await publishing.withdrawPublish(app.actor("owner"), app.key)).toBe("private");
    expect(await publishing.withdrawPublish(app.actor("owner"), app.key)).toBe("private");
    expect(await app.stored()).toMatchObject({ publishStatus: "private", reviewRequests: [] });
    // A new request can follow.
    expect(await publishing.requestPublish(app.actor("owner"), app.key)).toBe("publish_requested");
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("only the app's owners and admins request, in their own Workspace", async () => {
  const app = await fixture(db!);
  const other = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    expect(await refusal(publishing.requestPublish(app.actor("member"), app.key))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await refusal(publishing.withdrawPublish(app.actor("member"), app.key))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    // Another Workspace's owner cannot reach the app: it is not even confirmed to exist.
    expect(await refusal(publishing.requestPublish(other.actor("owner"), app.key))).toEqual({
      code: "NOT_FOUND",
      errorId: undefined,
    });
    expect((await app.stored()).publishStatus).toBe("private");
  } finally {
    await app.cleanup();
    await other.cleanup();
  }
});

test.skipIf(!db)("only a platform operator lists and decides requests", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    await publishing.requestPublish(app.actor("owner"), app.key);
    const requestId = await app.pendingId();
    for (const role of ["owner", "admin", "member"] as const) {
      expect(await refusal(publishing.listPendingReviews(app.actor(role)))).toMatchObject({
        code: "ACCESS_DENIED",
      });
      expect(
        await refusal(publishing.decide(app.actor(role), requestId, { outcome: "approved" })),
      ).toMatchObject({ code: "ACCESS_DENIED" });
    }
    expect((await app.stored()).publishStatus).toBe("publish_requested");

    const pending = await publishing.listPendingReviews(app.actor("reviewer"));
    expect(pending.find((entry) => entry.requestId === requestId)).toMatchObject({
      kind: "publish",
      publisherWorkspaceName: "Marketplace",
      app: { key: app.key, name: "Acme Insights", category: "data-analytics" },
    });
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("approving publishes, and a decided request stays decided", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    await publishing.requestPublish(app.actor("owner"), app.key);
    const requestId = await app.pendingId();
    await publishing.decide(app.actor("reviewer"), requestId, { outcome: "approved" });
    const stored = await app.stored();
    expect(stored.publishStatus).toBe("published");
    expect(stored.publishedAt).not.toBeNull();
    expect(stored.reviewRequests[0]).toMatchObject({
      outcome: "approved",
      decidedByUserId: app.people.reviewer.id,
    });

    expect(
      await refusal(publishing.decide(app.actor("reviewer"), requestId, { outcome: "rejected" })),
    ).toEqual({ code: "CONFLICT", errorId: "app-review-decided" });
    expect((await app.stored()).publishStatus).toBe("published");
    expect(
      await refusal(
        publishing.decide(app.actor("reviewer"), crypto.randomUUID(), { outcome: "approved" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("a rejection keeps its reason and allows a new request", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  try {
    await publishing.requestPublish(app.actor("owner"), app.key);
    await publishing.decide(app.actor("reviewer"), await app.pendingId(), {
      outcome: "rejected",
      reason: "  Homepage is missing  ",
    });
    const stored = await app.stored();
    expect(stored.publishStatus).toBe("rejected");
    expect(stored.reviewRequests[0]).toMatchObject({
      outcome: "rejected",
      reason: "Homepage is missing",
    });
    expect(await publishing.requestPublish(app.actor("owner"), app.key)).toBe("publish_requested");
    expect((await app.stored()).reviewRequests).toHaveLength(2);
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)(
  "unpublishing: request, approve to private, or reject back to published",
  async () => {
    const app = await fixture(db!);
    const publishing = createAppPublishing(db!);
    try {
      expect(await refusal(publishing.requestUnpublish(app.actor("owner"), app.key))).toMatchObject(
        { code: "CONFLICT" },
      );
      await publishing.requestPublish(app.actor("owner"), app.key);
      await publishing.decide(app.actor("reviewer"), await app.pendingId(), {
        outcome: "approved",
      });

      expect(await publishing.requestUnpublish(app.actor("owner"), app.key)).toBe(
        "unpublish_requested",
      );
      expect(await publishing.requestUnpublish(app.actor("owner"), app.key)).toBe(
        "unpublish_requested",
      );
      // Only a publish request can be withdrawn.
      expect(await refusal(publishing.withdrawPublish(app.actor("owner"), app.key))).toMatchObject({
        code: "CONFLICT",
      });
      await publishing.decide(app.actor("reviewer"), await app.pendingId(), {
        outcome: "rejected",
        reason: "still needed",
      });
      expect((await app.stored()).publishStatus).toBe("published");

      await publishing.requestUnpublish(app.actor("owner"), app.key);
      await publishing.decide(app.actor("reviewer"), await app.pendingId(), {
        outcome: "approved",
      });
      const stored = await app.stored();
      expect(stored.publishStatus).toBe("private");
      expect(stored.publishedAt).not.toBeNull();
    } finally {
      await app.cleanup();
    }
  },
);

test.skipIf(!db)("a published app, or one leaving the Marketplace, cannot be deleted", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  const registry = createAppRegistry(db!);
  try {
    await publishing.requestPublish(app.actor("owner"), app.key);
    await publishing.decide(app.actor("reviewer"), await app.pendingId(), { outcome: "approved" });
    const refused = { code: "CONFLICT", errorId: "app-published-undeletable" } as const;
    expect(await refusal(registry.deleteApp(app.actor("owner"), app.key))).toEqual(refused);
    await publishing.requestUnpublish(app.actor("owner"), app.key);
    expect(await refusal(registry.deleteApp(app.actor("owner"), app.key))).toEqual(refused);
    expect(await db!.app.count({ where: { key: app.key } })).toBe(1);

    await publishing.decide(app.actor("reviewer"), await app.pendingId(), { outcome: "approved" });
    await registry.deleteApp(app.actor("owner"), app.key);
    expect(await db!.app.count({ where: { key: app.key } })).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("an operator reads a pending app's logo; an outsider never does", async () => {
  const app = await fixture(db!);
  const publishing = createAppPublishing(db!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const outsider = await db!.user.create({
    data: { displayName: "outsider", username: `mkt-out-${suffix}` },
  });
  const operator = await db!.user.create({
    data: {
      displayName: "operator",
      username: `mkt-op-${suffix}`,
      platformOperator: { create: { role: "app_reviewer" } },
    },
  });
  try {
    const workspaceId = app.actor("owner").workspaceId;
    await db!.app.update({
      where: { key: app.key },
      data: { logoObjectKey: "logo/x", logoContentType: "image/png" },
    });
    const members = new PrismaAppRegistryStore(db!);
    const reviewers = new PrismaAppPublishingStore(db!);
    const read = (viewerUserId: string) =>
      reviewers.findLogoForReview({ workspaceId, key: app.key, viewerUserId });
    expect(await read(operator.id)).toBeUndefined();
    await publishing.requestPublish(app.actor("owner"), app.key);
    expect(await read(operator.id)).toMatchObject({ objectKey: "logo/x" });
    expect(await read(outsider.id)).toBeUndefined();
    // The reviewer path is not the member path: an operator is no member viewer.
    expect(
      await members.findLogo({ workspaceId, key: app.key, viewerUserId: operator.id }),
    ).toBeUndefined();
  } finally {
    await db!.user.deleteMany({ where: { id: { in: [outsider.id, operator.id] } } });
    await app.cleanup();
  }
});

test.skipIf(!db)("with app-marketplace off every operation is refused", async () => {
  const app = await fixture(db!, { flag: "off" });
  const publishing = createAppPublishing(db!);
  const off = { code: "ACCESS_DENIED", errorId: "app-marketplace-off" } as const;
  try {
    expect(
      await publishing.isEnabledIn({
        workspaceId: app.actor("owner").workspaceId,
        workspaceSlug: app.slug,
      }),
    ).toBe(false);
    expect(await refusal(publishing.requestPublish(app.actor("owner"), app.key))).toEqual(off);
    expect(await refusal(publishing.withdrawPublish(app.actor("owner"), app.key))).toEqual(off);
    expect(await refusal(publishing.requestUnpublish(app.actor("owner"), app.key))).toEqual(off);
    expect(await refusal(publishing.listPendingReviews(app.actor("reviewer")))).toEqual(off);
    expect(
      await refusal(
        publishing.decide(app.actor("reviewer"), crypto.randomUUID(), { outcome: "approved" }),
      ),
    ).toEqual(off);
    expect((await app.stored()).publishStatus).toBe("private");
  } finally {
    await app.cleanup();
  }
});

test.skipIf(!db)("granting a platform operator is idempotent and needs one match", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `Operator-${suffix}@example.test`;
  const user = await db!.user.create({
    data: { displayName: "op", username: `mkt-grant-${suffix}`, email },
  });
  const twin = await db!.user.create({
    data: {
      displayName: "twin",
      username: `mkt-twin-${suffix}`,
      email: `twin-${suffix}@example.test`,
    },
  });
  const twin2 = await db!.user.create({
    data: {
      displayName: "twin2",
      username: `mkt-twin2-${suffix}`,
      email: `TWIN-${suffix}@example.test`,
    },
  });
  try {
    expect(await grantPlatformOperator(db!, `nobody-${suffix}@example.test`)).toBe("no-user");
    expect(await grantPlatformOperator(db!, `twin-${suffix}@example.test`)).toBe("ambiguous");
    expect(await grantPlatformOperator(db!, email.toLowerCase())).toBe("granted");
    expect(await grantPlatformOperator(db!, email)).toBe("already");
    expect(await db!.platformOperator.count({ where: { userId: user.id } })).toBe(1);
    expect(await db!.platformOperator.count({ where: { userId: twin.id } })).toBe(0);
  } finally {
    await db!.user.deleteMany({ where: { id: { in: [user.id, twin.id, twin2.id] } } });
  }
});
