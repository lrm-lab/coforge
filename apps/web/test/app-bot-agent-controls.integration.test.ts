import { describe, expect, test } from "bun:test";

import { assertNotAppBot } from "#src/server/agents/active-agent.server";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import { ChangeAgentVisibility } from "#src/server/agents/change-agent-visibility.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { PrismaAgentDetailSource } from "#src/server/db/repositories/agent-detail.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { AgentDeletion } from "#src/server/agents/agent-deletion.server";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";
import { AgentMascots } from "#src/server/agents/agent-mascot.server";
import { setAgentRole } from "#src/server/agents/agent-role.server";
import { ChangeAgentRuntimeCredential } from "#src/server/agents/change-agent-runtime-credential.server";
import { AGENT_MASCOTS } from "#src/features/agents/agent-mascot";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { PrismaAgentMigrationStore } from "#src/server/db/repositories/agent-migration.repositories.server";
import { db, granted, refusal, statusRequest, useBotHarness } from "./app-bots-harness";

/**
 * Where a bot differs from an ordinary Agent, against local PostgreSQL: its profile reads the app
 * now, and the ordinary edit and visibility controls refuse it.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
useBotHarness();

describe.skipIf(!db)("a bot is not an ordinary Agent", () => {
  test("the Agent profile reads the app's name, logo and status now, and nothing of a Computer", async () => {
    const f = await granted();
    await statusRequest(f.installationId, f.basic, { text: "Indexing 2,341 packages" });
    const { agentId } = (await f.botRow())!;
    await db!.app.update({ where: { key: f.key }, data: { name: "Acme Renamed" } });
    const read = () =>
      new AgentDetailQuery(
        new PrismaAgentDetailSource(db!, {
          kind: "user",
          userId: f.people.member.id,
          role: "member",
        }),
      ).get(f.workspaceId, agentId, f.people.member.id);
    const profile = (await read())!;
    expect(profile.displayName).toBe("Acme Renamed");
    expect(profile.appBot).toMatchObject({
      appKey: f.key,
      appName: "Acme Renamed",
      statusText: "Indexing 2,341 packages",
    });
    expect(profile.computer).toBeUndefined();
    expect(profile.computerId).toBeNull();

    await f.bots.revoke(f.actor("admin"), f.key);
    expect((await read())!.appBot?.statusText).toBeNull();
  });

  test("the ordinary edit and visibility controls refuse it, even for its creator", async () => {
    const f = await granted();
    const { agentId } = (await f.botRow())!;
    const agents = new PrismaAgentRepository(db!);
    expect((await agents.getById(agentId))?.systemKind).toBe("app-bot");
    expect((await agents.getById(agentId))?.computerId).toBeUndefined();
    expect(() => assertNotAppBot({ systemKind: "app-bot" })).toThrow();
    const principal = { userId: f.people.admin.id, workspaceId: f.workspaceId };
    const manage = new ManageAgents(
      agents,
      { start: async () => {}, stop: async () => {} },
      { canRun: async () => true } as never,
      { run: (_id: string, work: () => Promise<unknown>) => work() } as never,
    );
    const computer = await db!.computer.create({
      data: { name: `c-${f.suffix}`, machineId: `m-${f.suffix}`, ownerId: f.people.admin.id },
    });
    const edit = await refusal(
      manage.update(principal, {
        agentId,
        computerId: computer.id,
        provider: "pi",
        model: "",
        modelProvider: "",
        reasoning: "",
        displayName: "x",
        description: "",
      } as never),
    );
    expect(edit).toMatchObject({ code: "ACCESS_DENIED", errorId: "app-bot-managed" });
    expect((await db!.agent.findUniqueOrThrow({ where: { id: agentId } })).computerId).toBeNull();
    const visibility = new ChangeAgentVisibility(
      agents,
      new PrismaChangeAgentVisibilityStore(db!),
      async () => {},
      { purge: async () => {} } as never,
    );
    const change = await refusal(
      visibility.execute({ ...principal, role: "admin" }, { agentId, visibility: "private" }),
    );
    expect(change.errorId).toBe("app-bot-managed");
    await db!.computer.delete({ where: { id: computer.id } });
  });
});

describe.skipIf(!db)("rosters", () => {
  test("people's Agent rosters leave the bot out, and the member pickers still offer it", async () => {
    const f = await granted();
    const { agentId } = (await f.botRow())!;
    const ordinary = await db!.agent.create({
      data: {
        workspaceId: f.workspaceId,
        name: `plain-${f.suffix}`,
        displayName: "Plain",
        ownerId: f.people.admin.id,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
    const owned = await new PrismaAgentRepository(db!).listOwnedInWorkspace(
      f.workspaceId,
      f.people.admin.id,
    );
    expect(owned.map((agent) => agent.id)).toEqual([ordinary.id]);

    const members = new WorkspaceMembers(db!);
    const page = await members.agentPage(f.workspaceId, f.people.member.id, {
      owner: "all",
      query: "",
      limit: 50,
    });
    expect(page.items.map((agent) => agent.id)).toEqual([ordinary.id]);
    expect((await members.summary(f.workspaceId, f.people.member.id)).agentCount).toBe(1);
    // Adding the bot to a channel goes through the picker, which lists every visible Agent.
    const picker = await members.directory(f.workspaceId, f.people.member.id);
    expect(picker.agents.map((agent) => agent.id)).toContain(agentId);
  });
});

describe.skipIf(!db)("every control a person could invoke on a bot", () => {
  test("delete, role, mascot, environment, runtime credential and migration all refuse it", async () => {
    const f = await granted();
    const { agentId } = (await f.botRow())!;
    const agents = new PrismaAgentRepository(db!);
    const lock = { run: (_id: string, work: () => Promise<unknown>) => work() } as never;
    const control = { start: async () => {}, stop: async () => {} };
    const admin = { userId: f.people.admin.id, workspaceId: f.workspaceId };

    const deletion = new AgentDeletion(agents, new PrismaAgentDeletionStore(db!), control, lock);
    expect((await refusal(deletion.delete({ ...admin, role: "admin" }, agentId))).errorId).toBe(
      "app-bot-managed",
    );
    expect(
      (
        await refusal(
          setAgentRole(db!, {
            workspaceId: f.workspaceId,
            actorUserId: admin.userId,
            agentId,
            role: "admin",
          }),
        )
      ).errorId,
    ).toBe("app-bot-managed");
    expect(
      (
        await refusal(
          new AgentMascots(db!).set(f.workspaceId, admin.userId, agentId, AGENT_MASCOTS[0]!),
        )
      ).errorId,
    ).toBe("app-bot-managed");
    const environment = new AgentEnvironment(
      {} as never,
      agents,
      control,
      lock,
      new Uint8Array(32),
    );
    expect((await refusal(environment.save(admin, agentId, { A: "b" }))).errorId).toBe(
      "app-bot-managed",
    );
    const credential = new ChangeAgentRuntimeCredential(agents, {} as never, control, lock);
    expect((await refusal(credential.save(admin, agentId, "key"))).errorId).toBe("app-bot-managed");
    const migrations = new AgentMigrations(new PrismaAgentMigrationStore(db!));
    expect(
      await migrations.request({
        workspaceId: f.workspaceId,
        agentId,
        targetComputerId: crypto.randomUUID(),
        requestedByUserId: admin.userId,
      }),
    ).toMatchObject({ status: "refused", code: "agent_unplaced" });
    expect((await db!.agent.findUniqueOrThrow({ where: { id: agentId } })).deletedAt).toBeNull();
    expect((await f.botRow())!.agent.role).toBe("member");
  });
});
