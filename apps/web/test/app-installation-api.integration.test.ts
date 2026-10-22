import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { exportJWK, generateKeyPair } from "jose";

import { PrismaClient } from "#src/generated/prisma/client";
import { Route as AgentsRoute } from "#src/routes/api.app-installations.$installationId.agents";
import { Route as ChannelsRoute } from "#src/routes/api.app-installations.$installationId.channels";
import { Route as WorkspaceRoute } from "#src/routes/api.app-installations.$installationId.workspace";
import { createAppPermissions } from "#src/server/app-permissions/app-permissions-composition.server";
import { createAppInstallationApi } from "#src/server/app-installation-data/app-installation-data-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import {
  readAuthorizationServerConfiguration,
  rememberAuthorizationServerConfiguration,
} from "#src/server/authorization-server/configuration.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { credentialsRequest } from "./oidc-installation-token-fixture";

/**
 * The read endpoints end to end against local PostgreSQL with migrations applied: an app's real
 * installation token, the `app-data-permissions` flag file, the route handlers, and the
 * projections of a Workspace holding private, archived and direct data.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` and `DATABASE_URL` point at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db =
  connectionString && Bun.env.DATABASE_URL
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
    : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUG = `instread-on-${RUN}`;
const ISSUER = "https://coforge.example/oidc";
let flagDirectory: string | undefined;
let signingKeys: Parameters<typeof createTokenEndpoints>[0]["signingKeys"] = [];

beforeAll(async () => {
  if (!db) return;
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingKeys = [{ ...(await exportJWK(privateKey)), kid: "current" }];
  rememberAuthorizationServerConfiguration(
    await readAuthorizationServerConfiguration({
      COFORGE_OIDC_ISSUER: ISSUER,
      COFORGE_OIDC_SIGNING_JWKS: JSON.stringify({ keys: signingKeys }),
    }),
  );
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-installation-read-"));
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

/** A Workspace with an app installed and `workspace` and `agent` approved, one public and one
 * private Agent, one channel and one direct conversation. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `instread-${suffix}`, username: `instread-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: ON_SLUG + suffix,
      name: "Reads",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  const key = `instread-${suffix}`;
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
  const declared = await permissions.declare(actor, key, ["workspace", "agent"]);
  await permissions.approve(actor, key, declared.revision);
  // Declared since, and not yet approved.
  const widened = await permissions.declare(actor, key, ["workspace", "agent", "computer"]);
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id, app: { key } },
    select: { id: true },
  });
  const agentData = { workspaceId: workspace.id, ownerId: owner.id, runtimeConfig: {} };
  await db.agent.create({ data: { ...agentData, name: "scout", displayName: "Scout" } });
  await db.agent.create({
    data: { ...agentData, name: "hush", displayName: "Hush", visibility: "private" },
  });
  await db.conversation.create({ data: { workspaceId: workspace.id, channelName: "general" } });
  const endpoints = createTokenEndpoints({ issuer: ISSUER, signingKeys, db });
  const tokenFor = async (scope: string) => {
    const response = await endpoints.token.exchange(
      credentialsRequest({
        authorization: `Basic ${btoa(`${key}:${clientSecret}`)}`,
        form: {
          resource: `https://coforge.example/api/app-installations/${installation.id}`,
          scope,
        },
      }),
    );
    return ((await response.json()) as { access_token: string }).access_token;
  };
  return {
    installationId: installation.id,
    tokenFor,
    approveWidened: () => permissions.approve(actor, key, widened.revision),
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

type Handler = (context: {
  request: Request;
  params: { installationId: string };
}) => Response | Promise<Response>;
const route = (r: { options: { server?: unknown } }) =>
  (r.options.server as { handlers: { GET: Handler } }).handlers.GET;
const get = (r: { options: { server?: unknown } }, installationId: string, token?: string) =>
  route(r)({
    request: new Request(`https://coforge.example/api/app-installations/${installationId}/x`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    params: { installationId },
  });

test.skipIf(!db)(
  "the routes answer an app's installation token with its approved groups",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor("installation:workspace installation:agent");

      const workspace = await get(WorkspaceRoute, f.installationId, token);
      expect(workspace.status).toBe(200);
      expect(await workspace.json()).toMatchObject({
        installation_id: f.installationId,
        workspace: { name: "Reads", picture_url: null },
      });

      const agents = await get(AgentsRoute, f.installationId, token);
      expect(agents.status).toBe(200);
      const body = (await agents.json()) as { agents: { handle: string }[] };
      expect(body.agents.map(({ handle }) => handle)).toEqual(["scout"]);

      // The channel group was never declared, so no token has it.
      const channels = await get(ChannelsRoute, f.installationId, token);
      expect(channels.status).toBe(403);
      expect(channels.headers.get("www-authenticate")).toContain('scope="installation:channel"');

      expect((await get(WorkspaceRoute, f.installationId)).status).toBe(401);
      expect((await get(WorkspaceRoute, f.installationId, "junk")).status).toBe(401);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an approval granted later opens the computer endpoint, with its presence",
  async () => {
    const f = await fixture(db!);
    try {
      const api = createAppInstallationApi({
        issuer: ISSUER,
        signingKeys,
        db: db!,
        presence: async (scopes) => scopes.map(() => true),
      });
      const read = async (token: string) =>
        api.read(
          new Request("https://coforge.example/x", {
            headers: { authorization: `Bearer ${token}` },
          }),
          f.installationId,
          "computer",
        );
      expect((await read(await f.tokenFor("installation:workspace"))).status).toBe(403);

      await f.approveWidened();
      const response = await read(await f.tokenFor("installation:computer"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ installation_id: f.installationId, computers: [] });
    } finally {
      await f.cleanup();
    }
  },
);
