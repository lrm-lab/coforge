import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AGENT_TOKEN_USAGE_METHOD,
  encodeAgentTokenUsage,
  type AgentTokenUsage,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { summarizeWorkspaceAgentUsage } from "#src/features/agents/workspace-agent-usage-model";
import {
  loadAgentTokenUsage,
  loadWorkspaceAgentTokenUsage,
} from "#src/server/agents/agent-token-usage.server";
import { agentReadingMethods } from "#src/server/centrifugo/agent-reading-methods";
import { CentrifugoRpcHandler } from "#src/server/centrifugo/rpc-handler.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";

function testDatabase(): PrismaClient {
  const connectionString = Bun.env.AGENT_ACTIVITY_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("AGENT_ACTIVITY_TEST_DATABASE_URL is required (local PostgreSQL)");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function buildRpcRequest(
  payload: AgentTokenUsage,
  principal: { userId: string; workspaceId: string; computerId: string },
): Request {
  const bytes = encodeAgentTokenUsage(payload);
  return new Request("http://127.0.0.1/api/internal/centrifugo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: AGENT_TOKEN_USAGE_METHOD,
      user: principal.userId,
      meta: {
        workspace_id: principal.workspaceId,
        computer_id: principal.computerId,
      },
      b64data: Buffer.from(bytes).toString("base64"),
    }),
  });
}

function makeRpcHandler(db: PrismaClient): CentrifugoRpcHandler {
  return new CentrifugoRpcHandler({
    methods: agentReadingMethods({
      agents: new PrismaAgentControlStore(db),
      display: {
        putContextUsage: async () => undefined,
        putServiceTier: async () => undefined,
      },
      events: {
        publishJson: async () => {},
      },
      db,
    }),
    authenticateEnvelope: async (envelope) => ({
      userId: envelope.user ?? "",
      workspaceId: String(envelope.meta?.workspace_id ?? ""),
      computerId: String(envelope.meta?.computer_id ?? ""),
    }),
  });
}

test("CentrifugoRpcHandler ingests token usage across changed launches, stopped/archived agents, and deduplicates retries", async () => {
  const db = testDatabase();
  const fixture = crypto.randomUUID();
  const runtimeConfig = {
    runtime: "codex",
    provider: { kind: "default" },
    model: "gpt-5.4",
    reasoning: "",
  };
  const owner = await db.user.create({
    data: { displayName: `usage-owner-${fixture}`, username: `usage-owner-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `usage-${fixture}`,
      name: "Usage RPC integration test",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });

  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: `usage-pc-${fixture}` },
    });
    const otherComputer = await db.computer.create({
      data: { ownerId: owner.id, machineId: `usage-other-${fixture}` },
    });
    await db.workspaceComputer.createMany({
      data: [
        { workspaceId: workspace.id, computerId: computer.id },
        { workspaceId: workspace.id, computerId: otherComputer.id },
      ],
    });

    const activeAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "active-bot",
        displayName: "Active Bot",
        runtimeConfig,
      },
    });
    await db.agent.update({
      where: { id: activeAgent.id },
      data: {
        controlState: {
          version: 1,
          protocolMajor: 1,
          requestId: fixture,
          workspaceId: workspace.id,
          computerId: computer.id,
          agentId: activeAgent.id,
          provider: "codex",
          epoch: 2,
          action: "start",
          phase: "completed",
          configRevision: "rev-1",
          launchId: "launch-current",
          controlSequence: 1,
          sessionSequence: 1,
        },
      },
    });

    const stoppedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "stopped-bot",
        displayName: "Stopped Bot",
        runtimeConfig,
        stoppedAt: new Date(),
      },
    });

    const archivedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "archived-bot",
        displayName: "Archived Bot",
        runtimeConfig,
        deletedAt: new Date(),
      },
    });

    const handler = makeRpcHandler(db);
    const nowMs = Date.now();
    const daemonPrincipal = {
      userId: owner.id,
      workspaceId: workspace.id,
      computerId: computer.id,
    };

    const basePayload = (overrides: Partial<AgentTokenUsage>): AgentTokenUsage => ({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      computerId: computer.id,
      agentId: activeAgent.id,
      provider: "codex",
      launchId: "launch-previous",
      sessionId: "sess-1",
      turnSeq: 1,
      model: "gpt-5.4",
      uncachedInputTokens: 1_000,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 200,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      contextUsedTokens: 12_000,
      contextWindowTokens: 200_000,
      observedAtMs: nowMs - 60_000,
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      ...overrides,
    });

    const staleLaunchRes = await handler.handleRequest(
      buildRpcRequest(basePayload({ launchId: "launch-previous", turnSeq: 1 }), daemonPrincipal),
    );
    expect(await staleLaunchRes.json()).toEqual({ result: { b64data: "" } });

    const duplicateRes = await handler.handleRequest(
      buildRpcRequest(
        basePayload({
          launchId: "launch-previous",
          turnSeq: 1,
          uncachedInputTokens: 999_999,
        }),
        daemonPrincipal,
      ),
    );
    expect(await duplicateRes.json()).toEqual({ result: { b64data: "" } });

    const stoppedRes = await handler.handleRequest(
      buildRpcRequest(
        basePayload({
          agentId: stoppedAgent.id,
          provider: "claude-code",
          launchId: "launch-shutdown",
          turnSeq: 3,
          model: "claude-sonnet-4-5",
          uncachedInputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 250,
        }),
        daemonPrincipal,
      ),
    );
    expect(await stoppedRes.json()).toEqual({ result: { b64data: "" } });

    const archivedRes = await handler.handleRequest(
      buildRpcRequest(
        basePayload({
          agentId: archivedAgent.id,
          launchId: "launch-final",
          turnSeq: 2,
          uncachedInputTokens: 700,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 300,
        }),
        daemonPrincipal,
      ),
    );
    expect(await archivedRes.json()).toEqual({ result: { b64data: "" } });

    const foreignRes = await handler.handleRequest(
      buildRpcRequest(
        basePayload({
          computerId: otherComputer.id,
          turnSeq: 99,
        }),
        daemonPrincipal,
      ),
    );
    expect(await foreignRes.json()).toEqual({
      error: { code: 403, message: "Agent token usage scope is not authorized" },
    });

    const rows = await db.agentTokenUsageTurn.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ turnSeq: "asc" }],
    });
    expect(rows).toHaveLength(3);
    const activeRow = rows.find((r) => r.agentId === activeAgent.id);
    expect(activeRow).toBeDefined();
    expect(activeRow?.launchId).toBe("launch-previous");
    expect(activeRow?.uncachedInputTokens).toBe(1_000n);
    expect(rows.find((r) => r.agentId === stoppedAgent.id)?.provider).toBe("claude-code");
    expect(rows.find((r) => r.agentId === archivedAgent.id)?.launchId).toBe("launch-final");
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("PrismaAgentTokenUsageRepository and loaders aggregate SQL ranges, preserve archived agent usage, and enforce member scoping", async () => {
  const db = testDatabase();
  const fixture = crypto.randomUUID();
  const admin = await db.user.create({
    data: {
      displayName: "Admin Owner",
      username: `usage-admin-${fixture}`,
      avatarObjectKey: `avatars/${fixture}.png`,
    },
  });
  const member = await db.user.create({
    data: { displayName: "Regular Member", username: `usage-member-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `usage-query-${fixture}`,
      name: "Usage query integration test",
      members: {
        create: [
          { userId: admin.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });

  try {
    const runtimeConfig = {
      runtime: "claude-code",
      provider: { kind: "default" },
      model: "claude-sonnet-4-5",
      reasoning: "",
    };
    const adminAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: admin.id,
        name: "alpha-agent",
        displayName: "Alpha Agent",
        runtimeConfig,
      },
    });
    const memberAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: member.id,
        name: "beta-agent",
        displayName: "Beta Agent",
        runtimeConfig: { ...runtimeConfig, runtime: "codex", model: "gpt-5.4" },
      },
    });
    const archivedUsedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: admin.id,
        name: "retired-used",
        displayName: "Retired Used",
        runtimeConfig,
        deletedAt: new Date(),
      },
    });
    const archivedUnusedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: admin.id,
        name: "retired-unused",
        displayName: "Retired Unused",
        runtimeConfig,
        deletedAt: new Date(),
      },
    });

    const repo = new PrismaAgentTokenUsageRepository(db);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await repo.recordTurn({
      workspaceId: workspace.id,
      agentId: adminAgent.id,
      launchId: "l-1",
      turnSeq: 1,
      provider: "claude-code",
      model: "claude-opus-4-6",
      uncachedInputTokens: 1_000,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 200,
      outputTokens: 300,
      contextUsedTokens: 10_000,
      contextWindowTokens: 200_000,
      recordedAt: twoHoursAgo,
    });
    await repo.recordTurn({
      workspaceId: workspace.id,
      agentId: adminAgent.id,
      launchId: "l-1",
      turnSeq: 2,
      provider: "claude-code",
      model: "claude-opus-4-6",
      uncachedInputTokens: 500,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
      outputTokens: 200,
      contextUsedTokens: 25_000,
      contextWindowTokens: 200_000,
      recordedAt: oneHourAgo,
    });
    await repo.recordTurn({
      workspaceId: workspace.id,
      agentId: memberAgent.id,
      launchId: "l-2",
      turnSeq: 1,
      provider: "codex",
      model: "gpt-5.4",
      uncachedInputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
      recordedAt: oneHourAgo,
    });
    await repo.recordTurn({
      workspaceId: workspace.id,
      agentId: archivedUsedAgent.id,
      launchId: "l-3",
      turnSeq: 1,
      provider: "claude-code",
      model: "claude-sonnet-4-5",
      uncachedInputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 200,
      recordedAt: oneHourAgo,
    });

    const singleSlices = await repo.aggregateTurnsInRange({
      workspaceId: workspace.id,
      agentId: adminAgent.id,
      since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      timeZone: "UTC",
      byHour: false,
    });
    expect(singleSlices.reduce((sum, s) => sum + s.turns, 0)).toBe(2);
    expect(
      singleSlices.reduce(
        (sum, s) => sum + s.uncachedInputTokens + s.cacheWriteTokens + s.outputTokens,
        0,
      ),
    ).toBe(2_200);
    const latestContextSlice = singleSlices.at(-1);
    expect(latestContextSlice?.contextUsedTokens).toBe(25_000);
    expect(latestContextSlice?.contextWindowTokens).toBe(200_000);

    const singleReport = await loadAgentTokenUsage(
      { user: admin, db, workspaceId: workspace.id } as never,
      { agentId: adminAgent.id, range: 7, timeZone: "UTC" },
    );
    expect(singleReport.currentProvider).toBe("claude-code");
    expect(singleReport.buckets.reduce((sum, b) => sum + b.effectiveTokens, 0)).toBe(2_200);

    const adminReport = await loadWorkspaceAgentTokenUsage(
      { user: admin, db, workspaceId: workspace.id } as never,
      { range: 7, timeZone: "UTC" },
    );
    expect(adminReport.agents.map((a) => a.id).sort()).toEqual(
      [adminAgent.id, memberAgent.id, archivedUsedAgent.id].sort(),
    );
    expect(adminReport.agents.find((a) => a.id === archivedUnusedAgent.id)).toBeUndefined();
    expect(adminReport.agents.find((a) => a.id === archivedUsedAgent.id)?.archived).toBe(true);
    expect(adminReport.agents.find((a) => a.id === adminAgent.id)?.ownerAvatarUrl).toContain(
      admin.id,
    );
    expect(adminReport.agents.find((a) => a.id === memberAgent.id)?.ownerAvatarUrl).toMatch(
      /^\/avatars\/person-/,
    );

    const adminAll = summarizeWorkspaceAgentUsage(adminReport, {
      selectedKey: null,
      owner: "all",
      viewerId: admin.id,
      query: "",
    });
    expect(adminAll.teamEffectiveTokens).toBe(6_200);
    expect(adminAll.visibleEffectiveTokens).toBe(6_200);
    expect(adminAll.rows.find((r) => r.agentId === archivedUsedAgent.id)?.archived).toBe(true);

    const adminMine = summarizeWorkspaceAgentUsage(adminReport, {
      selectedKey: null,
      owner: "mine",
      viewerId: admin.id,
      query: "",
    });
    expect(adminMine.visibleEffectiveTokens).toBe(3_200);
    expect(adminMine.timelineSummary.effectiveTokens).toBe(3_200);
    expect(adminMine.timelineBuckets.reduce((sum, b) => sum + b.effectiveTokens, 0)).toBe(3_200);
    expect(adminMine.timelineSummary.models.map((m) => m.model).sort()).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-5",
    ]);

    const memberReport = await loadWorkspaceAgentTokenUsage(
      { user: member, db, workspaceId: workspace.id } as never,
      { range: 7, timeZone: "UTC" },
    );
    expect(memberReport.agents.map((a) => a.id)).toEqual([memberAgent.id]);
    const memberSummary = summarizeWorkspaceAgentUsage(memberReport, {
      selectedKey: null,
      owner: "all",
      viewerId: member.id,
      query: "",
    });
    expect(memberSummary.teamEffectiveTokens).toBe(3_000);
    expect(memberSummary.timelineSummary.models.map((m) => m.model)).toEqual(["gpt-5.4"]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
    await db.$disconnect();
  }
});
