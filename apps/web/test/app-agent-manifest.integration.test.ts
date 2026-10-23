import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AgentAppListResponse } from "@lrm/coforge-sdk/agent";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { handleAgentAppList } from "#src/routes/api/agent/v1/apps/index";
import {
  createAgentAppUse,
  createAppAgentAccess,
} from "#src/server/app-agent-access/app-agent-access-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * An app's Agent manifest URL against local PostgreSQL with migrations applied, behind the
 * `app-agent-manifest` flag: what the registry stores, what an Agent's app list and the Agent
 * profile's grants show, and that a Workspace without the flag sees nothing of it.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUG = `manifest-on-${RUN}`;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-manifest-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-agent-manifest": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
          targeting: { if: [{ "==": [{ var: "workspaceSlug" }, ON_SLUG] }, "on", "off"] },
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

/** A Workspace (with the flag on, or not) whose owner made an Agent; `cleanup` removes it. */
async function fixture(db: PrismaClient, flagOn: boolean) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mf-${suffix}`, username: `mf-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: flagOn ? ON_SLUG : `manifest-off-${suffix}`,
      name: "Manifest",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `helper-${suffix}`,
      displayName: "Helper",
      ownerId: owner.id,
      runtimeConfig: {},
    },
  });
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  return {
    suffix,
    workspace,
    agent,
    actor,
    member: { workspaceId: workspace.id, userId: owner.id },
    principal: { workspaceId: workspace.id, agentId: agent.id },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.delete({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

const registration = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  description: "",
  whenToUse: "",
  homepageUrl: "https://notes.acme.example/app" as string | null,
  redirectUris: [],
  category: "other" as const,
  allowedScopes: ["openid", "profile", "identity"],
  ...extra,
});

async function refusal(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

const EXPLICIT = "https://api.acme.example/agents/guide.json";
const DERIVED = "https://notes.acme.example/.well-known/coforge-agent-manifest.json";

test.skipIf(!db)(
  "the registry stores, changes and clears the URL where the flag is on",
  async () => {
    const f = await fixture(db!, true);
    const registry = createAppRegistry(db!);
    try {
      const { app } = await registry.registerApp(
        f.actor,
        registration(`explicit-${f.suffix}`, { agentManifestUrl: EXPLICIT }),
      );
      expect(app.agentManifestUrl).toBe(EXPLICIT);
      const plain = await registry.registerApp(f.actor, registration(`plain-${f.suffix}`));
      expect(plain.app.agentManifestUrl).toBeNull();
      const changed = await registry.updateApp(f.actor, plain.app.key, {
        agentManifestUrl: "https://notes.acme.example/m.json",
      });
      expect(changed.agentManifestUrl).toBe("https://notes.acme.example/m.json");
      expect(
        (await registry.updateApp(f.actor, plain.app.key, { name: "Renamed" })).agentManifestUrl,
      ).toBe("https://notes.acme.example/m.json");
      expect(
        (await registry.updateApp(f.actor, plain.app.key, { agentManifestUrl: null }))
          .agentManifestUrl,
      ).toBeNull();
      const refused = await refusal(
        registry.updateApp(f.actor, plain.app.key, {
          agentManifestUrl: "http://notes.acme.example/m.json",
        }),
      );
      expect(isAppErrorCode(refused, "INVALID_INPUT")).toBe(true);
      expect((refused as { errorId?: string }).errorId).toBe("app-agent-manifest-url-invalid");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a Workspace without the flag cannot set the URL, but can still clear it",
  async () => {
    const f = await fixture(db!, false);
    const registry = createAppRegistry(db!);
    try {
      const refused = await refusal(
        registry.registerApp(
          f.actor,
          registration(`off-${f.suffix}`, { agentManifestUrl: EXPLICIT }),
        ),
      );
      expect(isAppErrorCode(refused, "ACCESS_DENIED")).toBe(true);
      expect((refused as { errorId?: string }).errorId).toBe("app-agent-manifest-off");
      expect(await db!.app.findUnique({ where: { key: `off-${f.suffix}` } })).toBeNull();
      const { app } = await registry.registerApp(
        f.actor,
        registration(`off-${f.suffix}`, { agentManifestUrl: null }),
      );
      expect(app.agentManifestUrl).toBeNull();
      expect(
        isAppErrorCode(
          await refusal(registry.updateApp(f.actor, app.key, { agentManifestUrl: EXPLICIT })),
          "ACCESS_DENIED",
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "the database refuses a manifest URL that is not https, too long, or has a fragment",
  async () => {
    const f = await fixture(db!, true);
    try {
      const { app } = await createAppRegistry(db!).registerApp(
        f.actor,
        registration(`check-${f.suffix}`),
      );
      for (const url of [
        "http://acme.example/m.json",
        "https://acme.example/m.json#top",
        `https://acme.example/${"a".repeat(2000)}`,
      ])
        await expect(
          (async () =>
            db!.app.update({ where: { key: app.key }, data: { agentManifestUrl: url } }))(),
        ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  },
);

async function listedApps(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await handleAgentAppList(f.principal, createAgentAppUse(db!));
  return ((await response.json()) as AgentAppListResponse).apps.filter((app) => !app.builtIn);
}

async function installApps(f: Awaited<ReturnType<typeof fixture>>) {
  const registry = createAppRegistry(db!);
  const keys = {
    explicit: `explicit-${f.suffix}`,
    derived: `derived-${f.suffix}`,
    none: `none-${f.suffix}`,
  };
  // Stored directly: a Workspace without the flag cannot set the URL, yet may hold one from before.
  await registry.registerApp(f.actor, registration(keys.explicit));
  await db!.app.update({ where: { key: keys.explicit }, data: { agentManifestUrl: EXPLICIT } });
  await registry.registerApp(f.actor, registration(keys.derived));
  await registry.registerApp(f.actor, registration(keys.none, { homepageUrl: null }));
  return keys;
}

test.skipIf(!db)(
  "an Agent's app list names each manifest location and its source where the flag is on",
  async () => {
    const f = await fixture(db!, true);
    try {
      const keys = await installApps(f);
      const byKey = new Map((await listedApps(f)).map((app) => [app.key, app]));
      expect(byKey.get(keys.explicit)).toMatchObject({
        agentManifestUrl: EXPLICIT,
        agentManifestUrlSource: "explicit",
      });
      expect(byKey.get(keys.derived)).toMatchObject({
        agentManifestUrl: DERIVED,
        agentManifestUrlSource: "well_known",
      });
      expect(byKey.get(keys.none)).toMatchObject({
        agentManifestUrl: null,
        agentManifestUrlSource: null,
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an Agent's app list is unchanged where the flag is off, a stored URL included",
  async () => {
    const f = await fixture(db!, false);
    try {
      await installApps(f);
      const apps = await listedApps(f);
      expect(apps).toHaveLength(3);
      for (const app of apps) {
        expect(Object.keys(app)).not.toContain("agentManifestUrl");
        expect(Object.keys(app)).not.toContain("agentManifestUrlSource");
      }
      const access = createAppAgentAccess(db!);
      const key = `explicit-${f.suffix}`;
      await access.grant(f.member, { agentId: f.agent.id, appKey: key, scopes: [] });
      const [grant] = (await access.list(f.member, f.agent.id)).grants;
      expect(grant?.appKey).toBe(key);
      expect(Object.keys(grant!)).not.toContain("agentManifestUrl");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "the Agent profile's grant row carries the resolved location where the flag is on",
  async () => {
    const f = await fixture(db!, true);
    try {
      const keys = await installApps(f);
      const access = createAppAgentAccess(db!);
      for (const key of [keys.explicit, keys.derived, keys.none])
        await access.grant(f.member, { agentId: f.agent.id, appKey: key, scopes: [] });
      const { grants, apps } = await access.list(f.member, f.agent.id);
      const byKey = new Map(grants.map((grant) => [grant.appKey, grant]));
      expect(byKey.get(keys.explicit)).toMatchObject({
        agentManifestUrl: EXPLICIT,
        agentManifestUrlSource: "explicit",
      });
      expect(byKey.get(keys.derived)).toMatchObject({
        agentManifestUrl: DERIVED,
        agentManifestUrlSource: "well_known",
      });
      expect(byKey.get(keys.none)).toMatchObject({
        agentManifestUrl: null,
        agentManifestUrlSource: null,
      });
      // The installed-app list of the grant panel carries no manifest field.
      for (const app of apps) expect(Object.keys(app)).not.toContain("agentManifestUrl");
    } finally {
      await f.cleanup();
    }
  },
);
