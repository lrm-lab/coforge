import { expect, test } from "bun:test";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { connectionString, setup } from "./helpers/agent-deletion-fixture";
import { teardown } from "./helpers/workspace-teardown";

/**
 * Task #431: a cloud Agent's username is the one its creator typed, and the creation's request id
 * is stored beside it (`Agent.createRequestId`, unique per Workspace) so a retried request finds
 * the Agent it made (`CreateCloudAgent`). Against local PostgreSQL, through the migrations; skipped
 * unless `CHANNEL_TEST_DATABASE_URL` points at it, like the other Agent repository suites.
 */
const runtimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

test.skipIf(!connectionString)(
  "a request id names one Agent per Workspace, and Agents made without one are unaffected",
  async () => {
    const { db, workspace, owner, member, agent } = await setup();
    const agents = new PrismaAgentRepository(db);
    const requestId = crypto.randomUUID();
    try {
      // The fixture's Agent, made without a request id, as every Agent before this column was.
      expect(
        (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).createRequestId,
      ).toBeNull();
      const created = await agents.create({
        workspaceId: workspace.id,
        name: "helper",
        displayName: "我的助手",
        ownerId: owner.id,
        runtimeConfig,
        createRequestId: requestId,
      });
      expect(
        await db.agent.findUnique({
          where: {
            workspaceId_createRequestId: { workspaceId: workspace.id, createRequestId: requestId },
          },
          select: { id: true, name: true },
        }),
      ).toEqual({ id: created.id, name: "helper" });

      // The same request again, under another name: the unique index refuses a second Agent.
      await expect(
        agents.create({
          workspaceId: workspace.id,
          name: "helper-two",
          displayName: "helper-two",
          ownerId: owner.id,
          runtimeConfig,
          createRequestId: requestId,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // Several Agents without a request id live side by side: NULLs never collide.
      for (const name of ["plain-one", "plain-two"])
        await agents.create({
          workspaceId: workspace.id,
          name,
          displayName: name,
          ownerId: owner.id,
          runtimeConfig,
        });
      expect(
        await db.agent.count({ where: { workspaceId: workspace.id, createRequestId: null } }),
      ).toBe(3);
    } finally {
      await teardown(db, workspace.id, [owner.id, member.id]);
    }
  },
);
