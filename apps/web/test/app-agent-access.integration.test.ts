import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { createAppAgentAccess } from "#src/server/app-agent-access/app-agent-access-composition.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";

/**
 * An Agent's access to the apps installed in its Workspace, against local PostgreSQL with
 * migrations applied: what granting, revoking, approving, denying and an Agent's use store.
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

const PEOPLE = ["owner", "admin", "member", "creator"] as const;
type Person = (typeof PEOPLE)[number];

/** A Workspace with an owner, an admin and two members, one of whom created its Agents; an app
 * installed in it and one installed only in another Workspace. `cleanup` removes all of it. */
async function workspaceFixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const people = {} as Record<Person, { id: string }>;
  for (const role of PEOPLE)
    people[role] = await db.user.create({
      data: { displayName: `access-${role}-${suffix}`, username: `access-${role}-${suffix}` },
    });
  const workspace = await db.workspace.create({
    data: {
      slug: `access-${suffix}`,
      name: "Access",
      members: {
        create: PEOPLE.map((role) => ({
          userId: people[role].id,
          role: role === "creator" ? "member" : role,
        })),
      },
    },
  });
  const elsewhere = await db.workspace.create({
    data: { slug: `access-else-${suffix}`, name: "Elsewhere" },
  });
  const agent = (name: string, visibility = "public") =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: people.creator.id,
        visibility,
        runtimeConfig: {},
      },
    });
  const app = (key: string, workspaceId: string) =>
    db.app.create({
      data: {
        key: `${key}-${suffix}`,
        ownerWorkspaceId: workspaceId,
        name: key === "notes" ? "Acme Notes" : "Other App",
        description: "Notes for the team.",
        homepageUrl: "https://notes.acme.example/",
        redirectUris: [],
        allowedScopes: ["openid", "profile", "identity", "email"],
        clientSecretHash: "0".repeat(64),
        installations: { create: { workspaceId } },
      },
    });
  return {
    workspace,
    agent: await agent("helper"),
    privateAgent: await agent("secret", "private"),
    app: await app("notes", workspace.id),
    otherApp: await app("other", elsewhere.id),
    /** That person, acting in the Workspace. */
    as: (role: Person) => ({ workspaceId: workspace.id, userId: people[role].id }),
    userId: (role: Person) => people[role].id,
    async cleanup() {
      for (const id of [workspace.id, elsewhere.id])
        await db.workspace.delete({ where: { id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: PEOPLE.map((role) => people[role].id) } } })
        .catch(() => {});
    },
  };
}

async function refusal(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

test.skipIf(!db)(
  "the Agent's creator grants an installed app, every member sees it, and an admin revokes it",
  async () => {
    const fixture = await workspaceFixture(db!);
    const access = createAppAgentAccess(db!);
    const agentId = fixture.agent.id;
    try {
      const before = await access.list(fixture.as("member"), agentId);
      expect(before).toMatchObject({ canManage: false, grants: [], pendingRequests: [] });
      expect(before.apps.map((app) => app.key)).toEqual([fixture.app.key]);

      expect(
        isAppErrorCode(
          await refusal(
            access.grant(fixture.as("member"), { agentId, appKey: fixture.app.key, scopes: [] }),
          ),
          "ACCESS_DENIED",
        ),
      ).toBe(true);

      await access.grant(fixture.as("creator"), {
        agentId,
        appKey: fixture.app.key,
        scopes: ["email"],
      });
      const granted = await access.list(fixture.as("member"), agentId);
      expect(granted.grants).toEqual([
        expect.objectContaining({
          appKey: fixture.app.key,
          appName: "Acme Notes",
          homepageUrl: "https://notes.acme.example/",
          scopes: ["openid", "profile", "identity", "email"],
          source: "person",
        }),
      ]);
      expect((await access.list(fixture.as("creator"), agentId)).canManage).toBe(true);

      await access.revoke(fixture.as("admin"), { agentId, grantId: granted.grants[0]!.id });
      expect((await access.list(fixture.as("owner"), agentId)).grants).toEqual([]);
      const row = await db!.appAgentGrant.findUniqueOrThrow({
        where: { id: granted.grants[0]!.id },
      });
      expect(row.revokedByUserId).toBe(fixture.userId("admin"));
      expect(row.revokedAt).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an Agent's first use grants the app automatically; after a revoke it waits for an approval",
  async () => {
    const fixture = await workspaceFixture(db!);
    const access = createAppAgentAccess(db!);
    const agent = { workspaceId: fixture.workspace.id, agentId: fixture.agent.id };
    const fixed = ["openid", "profile", "identity"];
    try {
      expect(await access.resolveAgentAccess(agent, fixture.app.key)).toEqual({
        status: "granted",
        scopes: fixed,
        automatic: true,
      });
      expect(await access.resolveAgentAccess(agent, fixture.app.key)).toEqual({
        status: "granted",
        scopes: fixed,
        automatic: false,
      });
      const [grant] = (await access.list(fixture.as("owner"), agent.agentId)).grants;
      expect(grant).toMatchObject({ source: "automatic", scopes: fixed });

      await access.revoke(fixture.as("creator"), { agentId: agent.agentId, grantId: grant!.id });
      const waiting = await access.resolveAgentAccess(agent, fixture.app.key, ["email"]);
      expect(waiting).toMatchObject({ status: "pending", scopes: [...fixed, "email"] });
      expect(await access.resolveAgentAccess(agent, fixture.app.key)).toEqual(waiting);
      const listed = await access.list(fixture.as("member"), agent.agentId);
      expect(listed.grants).toEqual([]);
      expect(listed.pendingRequests).toEqual([
        expect.objectContaining({ appKey: fixture.app.key, scopes: [...fixed, "email"] }),
      ]);

      const requestId = waiting.status === "pending" ? waiting.requestId : "";
      expect(
        isAppErrorCode(
          await refusal(
            access.approve(fixture.as("member"), { agentId: agent.agentId, requestId }),
          ),
          "ACCESS_DENIED",
        ),
      ).toBe(true);
      await access.approve(fixture.as("creator"), { agentId: agent.agentId, requestId });
      const approved = await access.list(fixture.as("member"), agent.agentId);
      expect(approved.pendingRequests).toEqual([]);
      expect(approved.grants).toEqual([
        expect.objectContaining({ source: "approval", scopes: [...fixed, "email"] }),
      ]);
      expect(await access.resolveAgentAccess(agent, fixture.app.key, ["email"])).toEqual({
        status: "granted",
        scopes: [...fixed, "email"],
        automatic: false,
      });
      expect(
        isAppErrorCode(
          await refusal(access.deny(fixture.as("owner"), { agentId: agent.agentId, requestId })),
          "CONFLICT",
        ),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)("a denied request leaves the Agent without the app", async () => {
  const fixture = await workspaceFixture(db!);
  const access = createAppAgentAccess(db!);
  const agent = { workspaceId: fixture.workspace.id, agentId: fixture.agent.id };
  try {
    await access.resolveAgentAccess(agent, fixture.app.key);
    const [grant] = (await access.list(fixture.as("owner"), agent.agentId)).grants;
    await access.revoke(fixture.as("owner"), { agentId: agent.agentId, grantId: grant!.id });
    const waiting = await access.resolveAgentAccess(agent, fixture.app.key);
    const requestId = waiting.status === "pending" ? waiting.requestId : "";

    await access.deny(fixture.as("admin"), { agentId: agent.agentId, requestId });
    const listed = await access.list(fixture.as("owner"), agent.agentId);
    expect(listed).toMatchObject({ grants: [], pendingRequests: [] });
    const row = await db!.appAgentAccessRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row).toMatchObject({ status: "denied", decidedByUserId: fixture.userId("admin") });
    expect(
      isAppErrorCode(
        await refusal(access.approve(fixture.as("owner"), { agentId: agent.agentId, requestId })),
        "CONFLICT",
      ),
    ).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)("a person's grant settles the Agent's pending request for that app", async () => {
  const fixture = await workspaceFixture(db!);
  const access = createAppAgentAccess(db!);
  const agent = { workspaceId: fixture.workspace.id, agentId: fixture.agent.id };
  try {
    await access.resolveAgentAccess(agent, fixture.app.key);
    const [grant] = (await access.list(fixture.as("owner"), agent.agentId)).grants;
    await access.revoke(fixture.as("owner"), { agentId: agent.agentId, grantId: grant!.id });
    await access.resolveAgentAccess(agent, fixture.app.key);

    await access.grant(fixture.as("owner"), {
      agentId: agent.agentId,
      appKey: fixture.app.key,
      scopes: [],
    });
    expect(await access.list(fixture.as("owner"), agent.agentId)).toMatchObject({
      grants: [expect.objectContaining({ source: "person" })],
      pendingRequests: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)("racing uses make one grant, and then one pending request", async () => {
  const fixture = await workspaceFixture(db!);
  const access = createAppAgentAccess(db!);
  const agent = { workspaceId: fixture.workspace.id, agentId: fixture.agent.id };
  const use = () => access.resolveAgentAccess(agent, fixture.app.key);
  try {
    const first = await Promise.all([use(), use(), use(), use()]);
    expect(first.every((outcome) => outcome.status === "granted")).toBe(true);
    expect(
      first.filter((outcome) => outcome.status === "granted" && outcome.automatic),
    ).toHaveLength(1);
    const [grant] = (await access.list(fixture.as("owner"), agent.agentId)).grants;
    await access.revoke(fixture.as("owner"), { agentId: agent.agentId, grantId: grant!.id });

    const waiting = await Promise.all([use(), use(), use(), use()]);
    const ids = new Set(
      waiting.map((outcome) => (outcome.status === "pending" ? outcome.requestId : "")),
    );
    expect([...ids]).toHaveLength(1);
    expect(ids.has("")).toBe(false);
    expect(await db!.appAgentAccessRequest.count({ where: { agentId: agent.agentId } })).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)(
  "an app installed only in another Workspace is not the Agent's to use or be granted",
  async () => {
    const fixture = await workspaceFixture(db!);
    const access = createAppAgentAccess(db!);
    const agentId = fixture.agent.id;
    try {
      expect(
        await access.resolveAgentAccess(
          { workspaceId: fixture.workspace.id, agentId },
          fixture.otherApp.key,
        ),
      ).toEqual({ status: "not_installed" });
      expect(
        isAppErrorCode(
          await refusal(
            access.grant(fixture.as("owner"), {
              agentId,
              appKey: fixture.otherApp.key,
              scopes: [],
            }),
          ),
          "NOT_FOUND",
        ),
      ).toBe(true);
      expect(
        isAppErrorCode(
          await refusal(
            access.grant(fixture.as("owner"), {
              agentId,
              appKey: fixture.app.key,
              scopes: ["calendar"],
            }),
          ),
          "INVALID_INPUT",
        ),
      ).toBe(true);
      expect(await db!.appAgentGrant.count({ where: { agentId } })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a private Agent's app access is hidden from members who cannot see it",
  async () => {
    const fixture = await workspaceFixture(db!);
    const access = createAppAgentAccess(db!);
    const agentId = fixture.privateAgent.id;
    try {
      expect(
        isAppErrorCode(await refusal(access.list(fixture.as("member"), agentId)), "NOT_FOUND"),
      ).toBe(true);
      expect((await access.list(fixture.as("admin"), agentId)).canManage).toBe(true);
      expect((await access.list(fixture.as("creator"), agentId)).canManage).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)("approving a request never narrows the Agent's active grant", async () => {
  const fixture = await workspaceFixture(db!);
  const access = createAppAgentAccess(db!);
  const agentId = fixture.agent.id;
  const fixed = ["openid", "profile", "identity"];
  try {
    // A request made while the grant was revoked, approved after a person granted more.
    await access.grant(fixture.as("owner"), {
      agentId,
      appKey: fixture.app.key,
      scopes: ["email"],
    });
    const request = await db!.appAgentAccessRequest.create({
      data: {
        appId: fixture.app.id,
        agentId,
        workspaceId: fixture.workspace.id,
        scopes: fixed,
      },
    });
    await access.approve(fixture.as("creator"), { agentId, requestId: request.id });
    expect((await access.list(fixture.as("owner"), agentId)).grants).toEqual([
      expect.objectContaining({ scopes: [...fixed, "email"] }),
    ]);
    expect(
      (await db!.appAgentAccessRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
    ).toBe("approved");
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)(
  "the Apps tab shows each app's logo; the Agent's own list of apps does not carry it",
  async () => {
    const fixture = await workspaceFixture(db!);
    const access = createAppAgentAccess(db!);
    const agent = { workspaceId: fixture.workspace.id, agentId: fixture.agent.id };
    const objectKey = `workspaces/${fixture.workspace.id}/apps/${fixture.app.key}/logos/l1/original`;
    const logoUrl = appLogoUrl(fixture.workspace.id, fixture.app.key, objectKey);
    try {
      await db!.app.update({
        where: { id: fixture.app.id },
        data: { logoObjectKey: objectKey, logoContentType: "image/png" },
      });
      expect(logoUrl).not.toBeNull();
      await access.resolveAgentAccess(agent, fixture.app.key);
      const granted = await access.list(fixture.as("member"), agent.agentId);
      expect(granted.apps).toEqual([expect.objectContaining({ key: fixture.app.key, logoUrl })]);
      expect(granted.grants).toEqual([expect.objectContaining({ appLogoUrl: logoUrl })]);

      await access.revoke(fixture.as("owner"), {
        agentId: agent.agentId,
        grantId: granted.grants[0]!.id,
      });
      await access.resolveAgentAccess(agent, fixture.app.key);
      expect((await access.list(fixture.as("member"), agent.agentId)).pendingRequests).toEqual([
        expect.objectContaining({ appKey: fixture.app.key, appLogoUrl: logoUrl }),
      ]);
      const [own] = await access.listForAgent(agent);
      expect(own).not.toHaveProperty("logoUrl");
    } finally {
      await fixture.cleanup();
    }
  },
);
