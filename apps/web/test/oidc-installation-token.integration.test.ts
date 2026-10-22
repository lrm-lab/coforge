import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppPermissions } from "#src/server/app-permissions/app-permissions-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { ISSUER, SIGNING_KEYS } from "./oidc-token-fixture";
import { credentialsRequest } from "./oidc-installation-token-fixture";

/**
 * Installation tokens against local PostgreSQL with migrations applied: the real installation,
 * declaration and approval behind a token, and the `app-data-permissions` flag file.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUG = `insttok-on-${RUN}`;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-installation-tokens-"));
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
          targeting: { if: [{ starts_with: [{ var: "workspaceSlug" }, ON_SLUG] }, "on", "off"] },
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

/** A Workspace whose owner registered an app declaring workspace and channel, with only the workspace
 * group approved. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `insttok-${suffix}`, username: `insttok-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: ON_SLUG + suffix,
      name: "Tokens",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  const key = `insttok-${suffix}`;
  const { clientSecret } = await createAppRegistry(db).registerApp(actor, {
    key,
    name: "Acme Insights",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "data-analytics",
    allowedScopes: ["openid", "profile", "identity"],
  });
  const permissions = createAppPermissions(db);
  const declared = await permissions.declare(actor, key, ["workspace"]);
  await permissions.approve(actor, key, declared.revision);
  await permissions.declare(actor, key, ["workspace", "channel"]);
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id, app: { key } },
    select: { id: true },
  });
  const endpoints = createTokenEndpoints({ issuer: ISSUER, signingKeys: SIGNING_KEYS, db });
  const request = (form: Record<string, string | undefined> = {}) =>
    credentialsRequest({
      authorization: `Basic ${btoa(`${key}:${clientSecret}`)}`,
      form: {
        resource: `https://coforge.example/api/app-installations/${installation.id}`,
        scope: "installation:workspace",
        ...form,
      },
    });
  return {
    actor,
    key,
    installationId: installation.id,
    permissions,
    endpoints,
    request,
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

test.skipIf(!db)(
  "an installation token is issued for approved groups and ends when the approval narrows or the app is uninstalled",
  async () => {
    const f = await fixture(db!);
    try {
      const response = await f.endpoints.token.exchange(f.request());
      expect(response.status).toBe(200);
      const { access_token } = (await response.json()) as { access_token: string };
      const verify = () =>
        f.endpoints.installationTokens.verify(access_token, f.installationId, new Date());
      expect(await verify()).toMatchObject({
        status: "verified",
        appKey: f.key,
        groups: ["workspace"],
      });

      // Declared but not approved.
      const pending = await f.endpoints.token.exchange(
        f.request({ scope: "installation:channel" }),
      );
      expect((await pending.json()) as { error: string }).toMatchObject({
        error: "invalid_scope",
      });

      // The app stops declaring the group: the token ends at once.
      await f.permissions.declare(f.actor, f.key, ["channel"]);
      expect(await verify()).toEqual({ status: "refused", error: "insufficient_scope" });

      await db!.appInstallation.delete({ where: { id: f.installationId } });
      expect(await verify()).toEqual({ status: "refused", error: "invalid_token" });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "with the flag off for the Workspace the grant is unauthorized_client",
  async () => {
    const f = await fixture(db!);
    try {
      await db!.workspace.update({
        where: { id: f.actor.workspaceId },
        data: { slug: `insttok-off-${RUN}` },
      });
      const response = await f.endpoints.token.exchange(f.request());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "unauthorized_client" });
    } finally {
      await f.cleanup();
    }
  },
);
