import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * Shared by the private share link integration tests: the database client (undefined unless
 * `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL), a flag file that turns the data
 * permission and notification flags on for the Workspaces `workspace()` makes, and Workspace and
 * app fixtures. A test file calls `registerShareFixture()` once at its top level.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
export const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 40 }, (_, index) => `msl-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

/** Registers the flag file and the database disconnect for the calling test file. */
export function registerShareFixture() {
  beforeAll(async () => {
    if (!db) return;
    flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-share-links-"));
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
}

/** A Workspace with an owner, an admin and a member; the flags are on. */
export async function workspace(db: PrismaClient, name: string) {
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
export async function scene(db: PrismaClient, status = "published") {
  const publisher = await workspace(db, "Acme Labs");
  const buyer = await workspace(db, "Buyer");
  const key = `msl-${crypto.randomUUID().slice(0, 8)}`;
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

export async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, errorId: error.errorId };
    throw error;
  }
  throw new Error("expected a refusal");
}

export const DAY = 24 * 60 * 60 * 1000;
