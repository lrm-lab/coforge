import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { handleAgentAppMarketplace } from "#src/routes/api/agent/v1/apps/marketplace";

/**
 * An Agent browsing the Marketplace with its own identity (task #477), against local PostgreSQL:
 * what a member of its Workspace may see and nothing more, whether its Workspace installed each
 * app, and the `query`/`limit` bounds. Every scene names its apps with a fresh token, so the
 * shared database's other published apps never match.
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

async function workspace(db: PrismaClient, name: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `o-${suffix}`, username: `o-${suffix}` },
  });
  const row = await db.workspace.create({
    data: {
      slug: `agent-mkt-${suffix}`,
      name,
      members: { create: [{ userId: owner.id, role: "owner" }] },
      agents: {
        create: {
          name: `scout-${suffix}`,
          displayName: "Scout",
          ownerId: owner.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  return {
    id: row.id,
    owner,
    agent: { workspaceId: row.id, agentId: row.agents[0]!.id },
    actor: { workspaceId: row.id, actorUserId: owner.id },
    async cleanup() {
      await db.workspace.delete({ where: { id: row.id } }).catch(() => {});
      await db.user.delete({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

/** A publisher with apps named after `token`, and a buyer Workspace with an Agent. */
async function scene(db: PrismaClient) {
  const token = `zq${crypto.randomUUID().slice(0, 8)}`;
  const publisher = await workspace(db, `Acme ${token}`);
  const buyer = await workspace(db, "Buyer");
  const other = await workspace(db, "Other");
  const register = async (name: string, status: string, description = "Reads things") => {
    const key = `amk-${crypto.randomUUID().slice(0, 8)}`;
    await createAppRegistry(db).registerApp(publisher.actor, {
      key,
      name,
      description,
      whenToUse: "",
      homepageUrl: "https://acme.example/home",
      redirectUris: ["https://acme.example/cb"],
      category: "data-analytics",
      allowedScopes: ["openid", "profile", "identity"],
    });
    await db.app.update({
      where: { key },
      data: { publishStatus: status, permissionGroups: ["workspace"], permissionRevision: 3 },
    });
    return key;
  };
  return {
    token,
    publisher,
    buyer,
    other,
    register,
    browse: (search: Record<string, string>, agent = buyer.agent) =>
      handleAgentAppMarketplace(
        new Request(`http://x/api/agent/v1/apps/marketplace?${new URLSearchParams(search)}`),
        agent,
        createAppInstallations(db),
      ),
    async cleanup() {
      await publisher.cleanup();
      await buyer.cleanup();
      await other.cleanup();
    },
  };
}

test.skipIf(!db)("an Agent sees what a member sees, and nothing of the owner's", async () => {
  const s = await scene(db!);
  try {
    const listed = await s.register(`${s.token} Insights`, "published");
    const hidden = await s.register(`${s.token} Draft`, "private");
    // Installed in another Workspace only: the buyer's view still says not installed.
    const app = await db!.app.findUniqueOrThrow({ where: { key: listed } });
    await db!.appInstallation.create({ data: { appId: app.id, workspaceId: s.other.id } });

    const response = await s.browse({ query: s.token });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      surface: "public_marketplace",
      metadataTrust: "untrusted_app_supplied",
      query: s.token,
      limit: 20,
      truncated: false,
    });
    expect(body.apps.map((row: { key: string }) => row.key)).toEqual([listed]);
    expect(body.apps.some((row: { key: string }) => row.key === hidden)).toBe(false);
    const [row] = body.apps;
    expect(Object.keys(row).sort()).toEqual(
      [
        "allowedScopes",
        "callbackDomains",
        "category",
        "description",
        "developer",
        "homepageHost",
        "homepageUrl",
        "installCount",
        "installed",
        "key",
        "logoUrl",
        "name",
        "notificationEvents",
        "permissionGroups",
        "publishedAt",
      ].sort(),
    );
    expect(row).toMatchObject({
      name: `${s.token} Insights`,
      developer: `Acme ${s.token}`,
      homepageHost: "acme.example",
      callbackDomains: ["acme.example"],
      installed: false,
      installCount: 2,
    });

    // Its own Workspace installing it shows; the publisher's Agent never sees its own app.
    await db!.appInstallation.create({ data: { appId: app.id, workspaceId: s.buyer.id } });
    const after = await (await s.browse({ query: s.token })).json();
    expect(after.apps[0]).toMatchObject({ key: listed, installed: true, installCount: 3 });
    const own = await (await s.browse({ query: s.token }, s.publisher.agent)).json();
    expect(own.apps).toEqual([]);
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)(
  "query matches name, key, description and developer, wildcards literally",
  async () => {
    const s = await scene(db!);
    try {
      const plain = await s.register(`${s.token} Plain`, "published");
      const percent = await s.register(
        `${s.token} 100% sure`,
        "published",
        "Under_score and \\slash",
      );
      const keys = async (query: string) =>
        ((await (await s.browse({ query })).json()).apps as { key: string }[]).map(
          (row) => row.key,
        );
      // The developer's name holds the token, so both match it, whatever their own names say.
      expect((await keys(s.token)).sort()).toEqual([plain, percent].sort());
      expect(await keys(`${s.token} PLAIN`)).toEqual([plain]);
      expect(await keys(plain)).toEqual([plain]);
      // `%`, `_` and `\` are text, not wildcards.
      expect(await keys(`${s.token} 100%`)).toEqual([percent]);
      expect(await keys(`${s.token} %`)).toEqual([]);
      expect(await keys(`${s.token}_`)).toEqual([]);
      expect((await keys("under_score")).includes(percent)).toBe(true);
      expect((await keys("under_scor_")).includes(percent)).toBe(false);
      expect((await keys("\\slash")).includes(percent)).toBe(true);
    } finally {
      await s.cleanup();
    }
  },
);

test.skipIf(!db)("limit is 1 to 50, default 20; query at most 200 characters", async () => {
  const s = await scene(db!);
  try {
    const keys = [];
    for (let index = 0; index < 3; index++)
      keys.push(await s.register(`${s.token} App ${index}`, "published"));
    const one = await (await s.browse({ query: s.token, limit: "1" })).json();
    expect(one).toMatchObject({ limit: 1, truncated: true });
    expect(one.apps.map((row: { key: string }) => row.key)).toEqual([keys[0]]);
    const all = await (await s.browse({ query: s.token, limit: "50" })).json();
    expect(all).toMatchObject({ limit: 50, truncated: false });
    expect(all.apps).toHaveLength(3);
    // Spaces around the query are dropped; an empty one lists everything (here, at least ours).
    expect((await (await s.browse({ query: `  ${s.token}  ` })).json()).query).toBe(s.token);
    expect((await (await s.browse({ query: "   " })).json()).query).toBeNull();
    expect((await (await s.browse({})).json()).query).toBeNull();
    // An empty `limit=` is no limit: the default.
    expect((await (await s.browse({ query: s.token, limit: "" })).json()).limit).toBe(20);
    expect((await s.browse({ query: "x".repeat(200) })).status).toBe(200);

    for (const search of <Record<string, string>[]>[
      { limit: "0" },
      { limit: "51" },
      { limit: "1.5" },
      { limit: "ten" },
      { query: "x".repeat(201) },
      // PostgreSQL text cannot hold NUL: refused here, not a database error.
      { query: "a\u0000b" },
    ]) {
      const refused = await s.browse(search);
      expect(refused.status).toBe(400);
      expect((await refused.json()).errorCode).toBe("invalid_input");
    }
  } finally {
    await s.cleanup();
  }
});

test.skipIf(!db)("an Agent that left its Workspace is refused", async () => {
  const s = await scene(db!);
  try {
    await db!.agent.update({
      where: { id: s.buyer.agent.agentId },
      data: { deletedAt: new Date() },
    });
    const refused = await s.browse({});
    expect(refused.status).toBe(404);
    expect((await refused.json()).errorCode).toBe("not_found");
  } finally {
    await s.cleanup();
  }
});
