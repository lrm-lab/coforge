import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { InstallationAgentScope } from "#src/server/app-agent-access/installation-agent-scope.server";
import { PrismaInstallationAgentScopeStore } from "#src/server/db/repositories/app-installation-agent-scope.repositories.server";
import {
  agentLaunchApps,
  createAppAgentAccess,
  createInstallationAgentScope,
} from "#src/server/app-agent-access/app-agent-access-composition.server";

/**
 * An installation's Agent access scope (All Agents, or Selected Agents) against local PostgreSQL
 * with migrations applied: who gets the automatic grant, what the Agent is told about, and who
 * may change the scope.
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

/** A Workspace with an owner and a member, two Agents and an app installed in it. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `scope-owner-${suffix}`, username: `scope-owner-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `scope-member-${suffix}`, username: `scope-member-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `scope-${suffix}`,
      name: "Scope",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const agent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: owner.id,
        visibility: "public",
        runtimeConfig: {},
      },
    });
  const app = await db.app.create({
    data: {
      key: `notes-${suffix}`,
      ownerWorkspaceId: workspace.id,
      name: "Acme Notes",
      description: "Notes for the team.",
      whenToUse: "Read the notes.",
      redirectUris: [],
      allowedScopes: ["openid", "profile", "identity"],
      clientSecretHash: "0".repeat(64),
      installations: { create: { workspaceId: workspace.id } },
    },
  });
  return {
    workspace,
    app,
    inside: await agent("inside"),
    outside: await agent("outside"),
    owner: { workspaceId: workspace.id, userId: owner.id },
    member: { workspaceId: workspace.id, userId: member.id },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } }).catch(() => {});
    },
  };
}

const refusal = async (action: Promise<unknown>) =>
  action.then(
    () => undefined,
    (e) => e,
  );

test.skipIf(!db)(
  "a new installation is available to all Agents, and automatic grants stay",
  async () => {
    const f = await fixture(db!);
    try {
      const scope = createInstallationAgentScope(db!);
      expect(await scope.view(f.member, f.app.key)).toEqual({ mode: "all", count: null });
      const access = createAppAgentAccess(db!);
      expect(
        await access.resolveAgentAccess(
          { workspaceId: f.workspace.id, agentId: f.outside.id },
          f.app.key,
        ),
      ).toMatchObject({ status: "granted", automatic: true });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "Selected Agents: only the selection is granted on first use, a person's grant still works for others, All restores it",
  async () => {
    const f = await fixture(db!);
    try {
      const scope = createInstallationAgentScope(db!);
      const access = createAppAgentAccess(db!);
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [f.inside.id] });
      const agent = (a: { id: string }) => ({ workspaceId: f.workspace.id, agentId: a.id });

      expect(await access.resolveAgentAccess(agent(f.inside), f.app.key)).toMatchObject({
        status: "granted",
        automatic: true,
      });
      expect(await access.resolveAgentAccess(agent(f.outside), f.app.key)).toMatchObject({
        status: "pending",
        appName: "Acme Notes",
      });
      expect(await db!.appAgentGrant.count({ where: { agentId: f.outside.id } })).toBe(0);

      // Lists: the app is hidden from the Agent outside, shown to the one inside.
      expect((await access.listForAgent(agent(f.outside))).map((a) => a.key)).toEqual([]);
      expect((await access.listForAgent(agent(f.inside))).map((a) => a.key)).toEqual([f.app.key]);
      expect(await agentLaunchApps(db!, f.workspace.id, f.outside.id)).toEqual([]);
      expect((await agentLaunchApps(db!, f.workspace.id, f.inside.id)).map((a) => a.key)).toEqual([
        f.app.key,
      ]);

      // An explicit grant works for an Agent outside the selection, and lists the app to it.
      await access.grant(f.owner, { agentId: f.outside.id, appKey: f.app.key, scopes: [] });
      expect(await access.resolveAgentAccess(agent(f.outside), f.app.key)).toMatchObject({
        status: "granted",
        automatic: false,
      });
      expect((await access.listForAgent(agent(f.outside))).map((a) => a.key)).toEqual([f.app.key]);
      expect((await agentLaunchApps(db!, f.workspace.id, f.outside.id)).length).toBe(1);

      // Switching changes no grant; the owner reads the selection back.
      expect(await scope.view(f.owner, f.app.key)).toMatchObject({
        mode: "selected",
        count: 1,
        agentIds: [f.inside.id],
      });
      expect(await scope.view(f.member, f.app.key)).toEqual({ mode: "selected", count: 1 });
      await scope.set(f.owner, f.app.key, { mode: "all", agentIds: [] });
      expect((await agentLaunchApps(db!, f.workspace.id, f.inside.id)).length).toBe(1);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "back to All Agents the Agent that asked meanwhile is granted, as is one that never asked",
  async () => {
    const f = await fixture(db!);
    try {
      const scope = createInstallationAgentScope(db!);
      const access = createAppAgentAccess(db!);
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [] });
      const outsider = { workspaceId: f.workspace.id, agentId: f.outside.id };
      expect(await access.resolveAgentAccess(outsider, f.app.key)).toMatchObject({
        status: "pending",
      });
      await scope.set(f.owner, f.app.key, { mode: "all", agentIds: [] });
      expect(await access.resolveAgentAccess(outsider, f.app.key)).toMatchObject({
        status: "granted",
        automatic: false,
      });
      expect(
        await access.resolveAgentAccess(
          { workspaceId: f.workspace.id, agentId: f.inside.id },
          f.app.key,
        ),
      ).toMatchObject({ status: "granted", automatic: true });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "only an owner or admin changes the scope, with Agents of the Workspace",
  async () => {
    const f = await fixture(db!);
    const elsewhere = await fixture(db!);
    try {
      const scope = createInstallationAgentScope(db!);
      const input = { mode: "selected" as const, agentIds: [f.inside.id] };
      expect(
        isAppErrorCode(await refusal(scope.set(f.member, f.app.key, input)), "ACCESS_DENIED"),
      ).toBe(true);
      expect(
        isAppErrorCode(
          await refusal(
            scope.set(f.owner, f.app.key, { ...input, agentIds: [elsewhere.inside.id] }),
          ),
          "INVALID_INPUT",
        ),
      ).toBe(true);
      expect(
        isAppErrorCode(await refusal(scope.set(f.owner, "no-such-app", input)), "NOT_FOUND"),
      ).toBe(true);
      expect(await scope.view(f.owner, f.app.key)).toMatchObject({ mode: "all" });
    } finally {
      await f.cleanup();
      await elsewhere.cleanup();
    }
  },
);

test.skipIf(!db)("deleting an Agent removes its selection", async () => {
  const f = await fixture(db!);
  try {
    const scope = createInstallationAgentScope(db!);
    await scope.set(f.owner, f.app.key, {
      mode: "selected",
      agentIds: [f.inside.id, f.outside.id],
    });
    await db!.agent.delete({ where: { id: f.outside.id } });
    expect(await db!.appInstallationAgent.count()).toBeGreaterThanOrEqual(1);
    expect(await db!.appInstallationAgent.count({ where: { agentId: f.outside.id } })).toBe(0);
    expect(await scope.view(f.owner, f.app.key)).toMatchObject({ count: 1 });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "widening the scope settles the pending requests of Agents now in scope, and system or deleted Agents cannot be selected",
  async () => {
    const f = await fixture(db!);
    try {
      const scope = createInstallationAgentScope(db!);
      const access = createAppAgentAccess(db!);
      const agent = (a: { id: string }) => ({ workspaceId: f.workspace.id, agentId: a.id });
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [] });
      await access.resolveAgentAccess(agent(f.inside), f.app.key);
      await access.resolveAgentAccess(agent(f.outside), f.app.key);
      const pending = (id: string) =>
        db!.appAgentAccessRequest.count({ where: { agentId: id, status: "pending" } });
      expect([await pending(f.inside.id), await pending(f.outside.id)]).toEqual([1, 1]);

      // Adding an Agent to the selection approves its request only.
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [f.inside.id] });
      expect([await pending(f.inside.id), await pending(f.outside.id)]).toEqual([0, 1]);
      const grant = await db!.appAgentGrant.findFirstOrThrow({ where: { agentId: f.inside.id } });
      expect(grant).toMatchObject({ source: "automatic", revokedAt: null });
      expect(
        await db!.appAgentAccessRequest.findFirstOrThrow({ where: { agentId: f.inside.id } }),
      ).toMatchObject({ status: "approved", decidedByUserId: f.owner.userId });

      await scope.set(f.owner, f.app.key, { mode: "all", agentIds: [] });
      expect(await pending(f.outside.id)).toBe(0);
      expect(await db!.appAgentGrant.count({ where: { agentId: f.outside.id } })).toBe(1);

      const system = await db!.agent.create({
        data: {
          workspaceId: f.workspace.id,
          name: `sys-${f.app.key}`,
          displayName: "Assistant",
          ownerId: f.owner.userId,
          visibility: "public",
          runtimeConfig: {},
          systemKind: "workspace_assistant",
        },
      });
      const gone = await db!.agent.create({
        data: {
          workspaceId: f.workspace.id,
          name: `gone-${f.app.key}`,
          displayName: "Gone",
          ownerId: f.owner.userId,
          visibility: "public",
          runtimeConfig: {},
          deletedAt: new Date(),
        },
      });
      const memory = await db!.agent.create({
        data: {
          workspaceId: f.workspace.id,
          name: `mem-${f.app.key}`,
          displayName: "Memory",
          ownerId: f.owner.userId,
          visibility: "public",
          runtimeConfig: {},
        },
      });
      await db!.workspaceMemoryAgent.create({
        data: { workspaceId: f.workspace.id, agentId: memory.id },
      });
      const view = await scope.view(f.owner, f.app.key);
      expect(view.candidates?.map((c) => c.id).sort()).toEqual([f.inside.id, f.outside.id].sort());
      for (const bad of [system.id, gone.id, memory.id])
        expect(
          isAppErrorCode(
            await refusal(scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [bad] })),
            "INVALID_INPUT",
          ),
        ).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "each request a wider scope settles is published as decided, best effort",
  async () => {
    const f = await fixture(db!);
    try {
      const published: [string, string][] = [];
      const scope = new InstallationAgentScope(
        new PrismaInstallationAgentScopeStore(db!),
        async (workspaceId, requestId) => {
          published.push([workspaceId, requestId]);
          throw new Error("realtime down");
        },
      );
      const access = createAppAgentAccess(db!);
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [] });
      await access.resolveAgentAccess(
        { workspaceId: f.workspace.id, agentId: f.inside.id },
        f.app.key,
      );
      await access.resolveAgentAccess(
        { workspaceId: f.workspace.id, agentId: f.outside.id },
        f.app.key,
      );
      const requests = await db!.appAgentAccessRequest.findMany({
        where: { workspaceId: f.workspace.id },
      });
      expect(published).toEqual([]);

      // The publish fails, the scope is saved all the same.
      await scope.set(f.owner, f.app.key, { mode: "selected", agentIds: [f.inside.id] });
      const insideRequest = requests.find((r) => r.agentId === f.inside.id)!;
      expect(published).toEqual([[f.workspace.id, insideRequest.id]]);
      expect(await scope.view(f.owner, f.app.key)).toMatchObject({ mode: "selected", count: 1 });
    } finally {
      await f.cleanup();
    }
  },
);
