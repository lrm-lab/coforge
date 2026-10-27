import { afterAll, expect, test } from "bun:test";
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

/**
 * An app's Agent manifest URL against local PostgreSQL with migrations applied: what the registry
 * stores, and what an Agent's app list and the Agent profile's grants show.
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

/** A Workspace whose owner made an Agent; `cleanup` removes it. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mf-${suffix}`, username: `mf-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `manifest-${suffix}`,
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

test.skipIf(!db)("the registry stores, changes and clears the URL", async () => {
  const f = await fixture(db!);
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
});

test.skipIf(!db)(
  "the database refuses a manifest URL that is not https, too long, or has a fragment",
  async () => {
    const f = await fixture(db!);
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
  await registry.registerApp(f.actor, registration(keys.explicit, { agentManifestUrl: EXPLICIT }));
  await registry.registerApp(f.actor, registration(keys.derived));
  await registry.registerApp(f.actor, registration(keys.none, { homepageUrl: null }));
  return keys;
}

test.skipIf(!db)("an Agent's app list names each manifest location and its source", async () => {
  const f = await fixture(db!);
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
});

test.skipIf(!db)("the Agent profile's grant row carries the resolved location", async () => {
  const f = await fixture(db!);
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
});
