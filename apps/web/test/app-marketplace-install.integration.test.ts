import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";
import { PrismaAuthorizationStore } from "#src/server/db/repositories/oauth-authorization.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * Installing a Marketplace app in another Workspace, against local PostgreSQL with migrations
 * applied: who sees which apps, the install and its approval, uninstalling, what an approved
 * offline request removes, and that Login with CoForge offers only Workspaces with the app.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 40 }, (_, index) => `mki-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-marketplace-install-"));
  const path = join(flagDirectory, "flags.json");
  const flag = {
    state: "ENABLED",
    variants: { on: true, off: false },
    defaultVariant: "off",
    targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
  };
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-data-permissions": flag,
        "app-notifications": flag,
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

/** A Workspace with an owner, an admin and a member; the flags are on. */
async function workspace(db: PrismaClient, name: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const roles = { owner: "owner", admin: "admin", member: "member" } as const;
  const people = {
    owner: await db.user.create({ data: { displayName: `o-${suffix}`, username: `o-${suffix}` } }),
    admin: await db.user.create({ data: { displayName: `a-${suffix}`, username: `a-${suffix}` } }),
    member: await db.user.create({ data: { displayName: `m-${suffix}`, username: `m-${suffix}` } }),
  };
  const row = await db.workspace.create({
    data: {
      slug: ON_SLUGS[nextOnSlug++]!,
      name,
      members: {
        create: (Object.keys(roles) as (keyof typeof roles)[]).map((role) => ({
          userId: people[role].id,
          role: roles[role],
        })),
      },
    },
  });
  return {
    id: row.id,
    people,
    actor: (role: keyof typeof roles) => ({ workspaceId: row.id, actorUserId: people[role].id }),
    async cleanup() {
      await db.workspace.delete({ where: { id: row.id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

/** Publisher and installer Workspaces, and the publisher's app at `status`, declaring `workspace`
 * data (revision 1). */
async function scene(db: PrismaClient, status = "published") {
  const publisher = await workspace(db, "Acme Labs");
  const buyer = await workspace(db, "Buyer");
  const key = `mki-${crypto.randomUUID().slice(0, 8)}`;
  await createAppRegistry(db).registerApp(publisher.actor("owner"), {
    key,
    name: "Acme Insights",
    description: "Reads things",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: ["https://acme.example/cb", "https://acme.example/cb2"],
    category: "data-analytics",
    allowedScopes: ["openid", "profile", "identity"],
  });
  const app = await db.app.update({
    where: { key },
    data: { publishStatus: status, permissionGroups: ["workspace"], permissionRevision: 1 },
  });
  const installation = (workspaceId: string) =>
    db.appInstallation.findUnique({ where: { appId_workspaceId: { appId: app.id, workspaceId } } });
  return {
    key,
    appId: app.id,
    publisher,
    buyer,
    installation,
    async cleanup() {
      await publisher.cleanup();
      await buyer.cleanup();
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

test.skipIf(!db)("another Workspace lists only published apps, never its own", async () => {
  const s = await scene(db!);
  const privateScene = await scene(db!, "private");
  try {
    const installs = createAppInstallations(db!);
    const listed = (await installs.browse(s.buyer.actor("member"))).listings;
    const mine = listed.find((app) => app.key === s.key);
    expect(mine).toMatchObject({
      name: "Acme Insights",
      developer: "Acme Labs",
      permissionGroups: ["workspace"],
      permissionRevision: 1,
      installed: false,
      installCount: 1,
    });
    expect(listed.some((app) => app.key === privateScene.key)).toBe(false);
    // The publisher's own app is not in its own Marketplace.
    expect(
      (await installs.browse(s.publisher.actor("owner"))).listings.some((a) => a.key === s.key),
    ).toBe(false);
    for (const status of ["publish_requested", "rejected"]) {
      await db!.app.update({ where: { key: privateScene.key }, data: { publishStatus: status } });
      expect(
        (await installs.browse(s.buyer.actor("member"))).listings.some(
          (a) => a.key === privateScene.key,
        ),
      ).toBe(false);
      expect(
        await refusal(installs.install(s.buyer.actor("owner"), privateScene.key, 1)),
      ).toMatchObject({ code: "NOT_FOUND" });
    }
  } finally {
    await s.cleanup();
    await privateScene.cleanup();
  }
});

test.skipIf(!db)("an owner or admin installs and approves what was shown", async () => {
  const s = await scene(db!);
  try {
    const installs = createAppInstallations(db!);
    expect(await refusal(installs.install(s.buyer.actor("member"), s.key, 1))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await s.installation(s.buyer.id)).toBeNull();

    // A declaration that moved on since it was shown installs nothing.
    expect(await refusal(installs.install(s.buyer.actor("admin"), s.key, 0))).toEqual({
      code: "CONFLICT",
      errorId: "app-permissions-changed",
    });
    expect(await s.installation(s.buyer.id)).toBeNull();

    await installs.install(s.buyer.actor("admin"), s.key, 1);
    expect(await s.installation(s.buyer.id)).toMatchObject({
      installedByUserId: s.buyer.people.admin.id,
      agentAccess: "all",
      approvedGroups: ["workspace"],
      approvedRevision: 1,
      approvedByUserId: s.buyer.people.admin.id,
    });
    // Installing again changes nothing.
    await installs.install(s.buyer.actor("owner"), s.key, 1);
    expect(await db!.appInstallation.count({ where: { appId: s.appId } })).toBe(2);
    const listed = (await installs.browse(s.buyer.actor("member"))).listings;
    expect(listed.find((app) => app.key === s.key)).toMatchObject({
      installed: true,
      installCount: 2,
    });
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("an app waiting to go offline is still installable", async () => {
  const s = await scene(db!, "unpublish_requested");
  try {
    await createAppInstallations(db!).install(s.buyer.actor("owner"), s.key, 1);
    expect(await s.installation(s.buyer.id)).not.toBeNull();
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("a person who is not a member of the Workspace is refused", async () => {
  const s = await scene(db!);
  try {
    const installs = createAppInstallations(db!);
    const outsider = { workspaceId: s.buyer.id, actorUserId: s.publisher.people.owner.id };
    for (const refused of [
      () => installs.browse(outsider),
      () => installs.install(outsider, s.key, 1),
      () => installs.uninstall(outsider, s.key),
    ])
      expect(await refusal(refused())).toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await s.cleanup();
  }
});

/** Gives the installer's Workspace everything an installed app accumulates. */
async function useTheApp(s: Awaited<ReturnType<typeof scene>>) {
  const d = db!;
  await d.userAppConsent.create({
    data: {
      userId: s.buyer.people.member.id,
      appId: s.appId,
      workspaceId: s.buyer.id,
      scopes: ["openid"],
    },
  });
  await d.oAuthAuthorizationCode.create({
    data: {
      codeHash: crypto.randomUUID(),
      appId: s.appId,
      userId: s.buyer.people.member.id,
      workspaceId: s.buyer.id,
      redirectUri: "https://acme.example/cb",
      codeChallenge: "x",
      scopes: ["openid"],
      authTime: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const agent = await d.agent.create({
    data: {
      workspaceId: s.buyer.id,
      name: `helper-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Helper",
      ownerId: s.buyer.people.owner.id,
      visibility: "public",
      runtimeConfig: {},
    },
  });
  await d.appAgentGrant.create({
    data: {
      appId: s.appId,
      agentId: agent.id,
      workspaceId: s.buyer.id,
      scopes: ["openid", "profile", "identity"],
      source: "automatic",
    },
  });
  await d.appAgentAccessRequest.create({
    data: {
      appId: s.appId,
      agentId: agent.id,
      workspaceId: s.buyer.id,
      scopes: ["openid", "profile", "identity"],
    },
  });
  return agent;
}

async function assertRevoked(s: Awaited<ReturnType<typeof scene>>, agentId: string) {
  const d = db!;
  const where = { appId: s.appId, workspaceId: s.buyer.id };
  expect(await s.installation(s.buyer.id)).toBeNull();
  expect((await d.userAppConsent.findFirstOrThrow({ where })).revokedAt).not.toBeNull();
  expect(await d.oAuthAuthorizationCode.count({ where })).toBe(0);
  expect(
    (await d.appAgentGrant.findFirstOrThrow({ where: { ...where, agentId } })).revokedAt,
  ).not.toBeNull();
  expect((await d.appAgentAccessRequest.findFirstOrThrow({ where })).status).toBe("denied");
}

test.skipIf(!db)("uninstalling revokes the Workspace's grants and keeps its own app", async () => {
  const s = await scene(db!);
  try {
    const installs = createAppInstallations(db!);
    await installs.install(s.buyer.actor("owner"), s.key, 1);
    const agent = await useTheApp(s);
    expect(await refusal(installs.uninstall(s.buyer.actor("member"), s.key))).toMatchObject({
      code: "ACCESS_DENIED",
    });
    // The publisher's own app is deleted, not uninstalled.
    expect(await refusal(installs.uninstall(s.publisher.actor("owner"), s.key))).toMatchObject({
      code: "NOT_FOUND",
    });
    await installs.uninstall(s.buyer.actor("admin"), s.key);
    await assertRevoked(s, agent.id);
    expect(await s.installation(s.publisher.id)).not.toBeNull();
    expect(await refusal(installs.uninstall(s.buyer.actor("admin"), s.key))).toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("an approved offline request removes every other Workspace's access", async () => {
  const s = await scene(db!);
  const reviewer = await db!.user.create({
    data: { displayName: "rev", username: `rev-${crypto.randomUUID().slice(0, 8)}` },
  });
  try {
    await db!.platformOperator.create({ data: { userId: reviewer.id, role: "app_reviewer" } });
    await db!.workspaceMembership.create({
      data: { workspaceId: s.publisher.id, userId: reviewer.id, role: "member" },
    });
    await createAppInstallations(db!).install(s.buyer.actor("owner"), s.key, 1);
    const agent = await useTheApp(s);
    const publishing = createAppPublishing(db!);
    const reviewerActor = { workspaceId: s.publisher.id, actorUserId: reviewer.id };

    // A rejection changes nothing for installs.
    await publishing.requestUnpublish(s.publisher.actor("owner"), s.key);
    const request = await db!.appReviewRequest.findFirstOrThrow({
      where: { appId: s.appId, outcome: null },
    });
    await publishing.decide(reviewerActor, request.id, { outcome: "rejected" });
    expect(await s.installation(s.buyer.id)).not.toBeNull();

    await publishing.requestUnpublish(s.publisher.actor("owner"), s.key);
    const second = await db!.appReviewRequest.findFirstOrThrow({
      where: { appId: s.appId, outcome: null },
    });
    await publishing.decide(reviewerActor, second.id, { outcome: "approved" });
    await assertRevoked(s, agent.id);
    // The publisher keeps its own installation, so it can still manage the app.
    expect(await s.installation(s.publisher.id)).not.toBeNull();
    expect((await db!.app.findUniqueOrThrow({ where: { key: s.key } })).publishStatus).toBe(
      "private",
    );
  } finally {
    await s.cleanup();
    await db!.user.delete({ where: { id: reviewer.id } }).catch(() => {});
  }
});

test.skipIf(!db)(
  "Login with CoForge offers only Workspaces where the app is installed",
  async () => {
    const s = await scene(db!);
    try {
      // One person belongs to the publisher and to the Workspace that installs the app later.
      const person = s.buyer.people.member;
      await db!.workspaceMembership.create({
        data: { workspaceId: s.publisher.id, userId: person.id, role: "member" },
      });
      const store = new PrismaAuthorizationStore(db!);
      const names = async () =>
        (await store.listOfferedWorkspaces(s.appId, person.id)).map((offered) => offered.id);
      expect(await names()).toEqual([s.publisher.id]);
      await createAppInstallations(db!).install(s.buyer.actor("owner"), s.key, 1);
      expect((await names()).sort()).toEqual([s.publisher.id, s.buyer.id].sort());
      await createAppInstallations(db!).uninstall(s.buyer.actor("owner"), s.key);
      expect(await names()).toEqual([s.publisher.id]);
      expect(await store.findOfferedWorkspace(s.appId, person.id, s.buyer.id)).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a listed app's logo is readable before an install, a private one's is not",
  async () => {
    const s = await scene(db!);
    try {
      await db!.app.update({
        where: { key: s.key },
        data: { logoObjectKey: "logo-object", logoContentType: "image/png" },
      });
      const store = new PrismaAppRegistryStore(db!);
      const logoFor = () =>
        store.findLogo({
          workspaceId: s.publisher.id,
          key: s.key,
          viewerUserId: s.buyer.people.member.id,
        });
      expect(await logoFor()).toEqual({ objectKey: "logo-object", contentType: "image/png" });
      await db!.app.update({ where: { key: s.key }, data: { publishStatus: "private" } });
      expect(await logoFor()).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an install that waits on an app going offline is refused, not left installed",
  async () => {
    const s = await scene(db!);
    try {
      const installs = createAppInstallations(db!);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // The offline approval's transaction: it has taken the app row and changed its status.
      const offline = db!.$transaction(async (tx) => {
        await tx.app.update({ where: { key: s.key }, data: { publishStatus: "private" } });
        locked();
        await held;
      });
      await lockTaken;
      const install = refusal(installs.install(s.buyer.actor("owner"), s.key, 1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await offline;
      expect(await install).toMatchObject({ code: "NOT_FOUND" });
      expect(await s.installation(s.buyer.id)).toBeNull();
    } finally {
      await s.cleanup();
    }
  },
);
