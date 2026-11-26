import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { BatchAgentRuntimeConfig } from "#src/server/agents/batch-agent-runtime-config.server";
import { AgentConfigApply } from "#src/server/agents/agent-config-apply.server";
import { agentControlRevision } from "#src/server/agents/agent-control-types.server";
import { decryptAgentEnvironment } from "#src/server/agents/agent-environment.server";
import type { AgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";

const principal = { workspaceId: "workspace-1", userId: "owner-1" };
const envKey = new Uint8Array(32).fill(9);

type FixtureAgent = AgentRecord & {
  encryptedEnv?: Record<string, string>;
};

function makeAgent(overrides: Partial<FixtureAgent> & { id: string }): FixtureAgent {
  const { id, ...rest } = overrides;
  return {
    id,
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    computerId: "computer-1",
    name: `agent-${id}`,
    displayName: `Agent ${id}`,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    runtimeConfigRevision: 1,
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
      provider: { kind: "default" },
      model: "claude-sonnet-4-5",
      modelProvider: "",
      reasoning: "medium",
    },
    ...rest,
  };
}

function createFixture(
  initialAgents: FixtureAgent[],
  options: {
    supportsPush?: boolean;
    failWriteIds?: Set<string>;
    refusal?: string | null;
    runningAgentIds?: Set<string>;
  } = {},
) {
  const byId = new Map(initialAgents.map((agent) => [agent.id, agent]));
  const events: string[] = [];
  const pushedAgentIds: string[] = [];
  const stoppedAgentIds: string[] = [];
  const startedAgentIds: string[] = [];
  const availabilityChecks: Array<{ computerId: string; provider: string; hasApiKey: boolean }> =
    [];

  const configApply = new AgentConfigApply(
    options.supportsPush
      ? {
          supports: async () => true,
          publish: async (sync) => {
            pushedAgentIds.push(sync.agentId);
            events.push(`push:${sync.agentId}`);
          },
        }
      : undefined,
    options.supportsPush
      ? {
          get: async (agentId) => {
            if (!options.runningAgentIds?.has(agentId)) return undefined;
            const agent = byId.get(agentId);
            if (!agent?.runtimeConfig) return undefined;
            const rev = agentControlRevision(agent.runtimeConfig);
            const state = {
              version: 1 as const,
              protocolMajor: 1 as const,
              requestId: "req-1",
              workspaceId: agent.workspaceId,
              computerId: agent.computerId!,
              agentId: agent.id,
              provider: agent.runtimeConfig.runtime,
              epoch: 1,
              action: "start" as const,
              phase: "completed" as const,
              configRevision: rev,
              controlSequence: 1,
              sessionSequence: 1,
            };
            return {
              id: agent.id,
              workspaceId: agent.workspaceId,
              computerId: agent.computerId,
              runtimeConfig: agent.runtimeConfig,
              storedControlState: state,
              state,
            } as never;
          },
        }
      : undefined,
  );

  const service = new BatchAgentRuntimeConfig(
    {
      getById: async (id) => byId.get(id),
      update: async (id, data) => {
        if (options.failWriteIds?.has(id)) throw new Error("write failed");
        const existing = byId.get(id)!;
        const next: FixtureAgent = {
          ...existing,
          ...(data.runtimeConfig ? { runtimeConfig: data.runtimeConfig } : {}),
          runtimeConfigRevision: (existing.runtimeConfigRevision ?? 0) + 1,
        };
        byId.set(id, next);
        events.push(`write:${id}`);
        return next;
      },
    },
    {
      start: async (intent) => {
        startedAgentIds.push(intent.agentId);
        events.push(`start:${intent.agentId}`);
      },
      stop: async (intent) => {
        stoppedAgentIds.push(intent.agentId);
        events.push(`stop:${intent.agentId}`);
      },
    },
    {
      canRun: async (_ws, _u, computerId, config) => {
        availabilityChecks.push({
          computerId,
          provider: config.provider,
          hasApiKey: config.hasApiKey,
        });
        return options.refusal == null;
      },
      refusal: async (_ws, _u, computerId, config) => {
        availabilityChecks.push({
          computerId,
          provider: config.provider,
          hasApiKey: config.hasApiKey,
        });
        return options.refusal ?? null;
      },
    },
    {
      run: async (_id, fn) => fn(),
    },
    async () => ({
      encrypt: async (_agentId, _providerId, apiKey) => ({
        keyId: "v1",
        ciphertext: Buffer.from(`enc:${apiKey}`).toString("base64"),
        nonce: "nonce",
        hint: `...${apiKey.slice(-4)}`,
      }),
    }),
    async () => envKey,
    configApply,
  );

  return {
    service,
    byId,
    events,
    pushedAgentIds,
    stoppedAgentIds,
    startedAgentIds,
    availabilityChecks,
  };
}

describe("BatchAgentRuntimeConfig", () => {
  test("updates runtime and patches environment in one write per Agent without wiping untouched env keys", async () => {
    const a1 = makeAgent({ id: "a1" });
    const a2 = makeAgent({
      id: "a2",
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CODEX,
        provider: { kind: "default" },
        model: "gpt-5.3-codex",
        modelProvider: "",
        reasoning: "high",
      },
    });
    const f = createFixture([a1, a2], {
      supportsPush: true,
      runningAgentIds: new Set(["a1", "a2"]),
    });

    const seeded = await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1", "a2"],
      environmentPatch: {
        set: { KEEP_ME: "original", DEBUG_TRACE: "1" },
        remove: [],
      },
    });
    expect(seeded.succeeded).toHaveLength(2);
    f.events.length = 0;
    f.pushedAgentIds.length = 0;
    f.stoppedAgentIds.length = 0;
    f.startedAgentIds.length = 0;

    const result = await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1", "a2"],
      runtime: {
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
        model: "claude-opus-4-5",
        modelProvider: "",
        reasoning: "high",
        fastMode: true,
      },
      environmentPatch: {
        set: { HTTP_PROXY: "http://127.0.0.1:7890" },
        remove: ["DEBUG_TRACE"],
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.succeeded).toEqual([
      { agentId: "a1", restart: "when-idle" },
      { agentId: "a2", restart: "published" },
    ]);
    expect(f.pushedAgentIds).toEqual(["a1"]);
    expect(f.stoppedAgentIds).toEqual(["a2"]);
    expect(f.startedAgentIds).toEqual(["a2"]);

    const a1Config = f.byId.get("a1")!.runtimeConfig as AgentRuntimeConfig;
    const a1Env = await decryptAgentEnvironment("a1", a1Config.environment, envKey);
    expect(a1Env).toEqual({ KEEP_ME: "original", HTTP_PROXY: "http://127.0.0.1:7890" });
    expect(a1Config.model).toBe("claude-opus-4-5");
    expect(a1Config.fastMode).toBe(true);

    const a2Config = f.byId.get("a2")!.runtimeConfig as AgentRuntimeConfig;
    const a2Env = await decryptAgentEnvironment("a2", a2Config.environment, envKey);
    expect(a2Env).toEqual({ KEEP_ME: "original", HTTP_PROXY: "http://127.0.0.1:7890" });
    expect(a2Config.runtime).toBe(RUNTIME_PROVIDER.CLAUDE_CODE);
  });

  test("environment-only patch keeps each Agent's own runtime and pushes when-idle without restarting", async () => {
    const a1 = makeAgent({ id: "a1" });
    const a2 = makeAgent({
      id: "a2",
      stoppedAt: new Date("2026-10-02T00:00:00Z"),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CODEX,
        provider: { kind: "default" },
        model: "gpt-5.3-codex",
        modelProvider: "",
        reasoning: "high",
      },
    });
    const f = createFixture([a1, a2], {
      supportsPush: true,
      runningAgentIds: new Set(["a1"]),
    });

    const result = await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1", "a2"],
      environmentPatch: {
        set: { LOG_LEVEL: "debug" },
        remove: [],
      },
    });

    expect(result.succeeded).toEqual([
      { agentId: "a1", restart: "when-idle" },
      { agentId: "a2", restart: "deferred" },
    ]);
    expect(f.stoppedAgentIds).toEqual([]);
    expect(f.byId.get("a1")!.runtimeConfig!.runtime).toBe(RUNTIME_PROVIDER.CLAUDE_CODE);
    expect(f.byId.get("a2")!.runtimeConfig!.runtime).toBe(RUNTIME_PROVIDER.CODEX);
  });

  test("skips non-owned Agents and unchanged Agents, and isolates per-Agent write failures", async () => {
    const ownedSame = makeAgent({
      id: "a1",
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
        provider: { kind: "default" },
        model: "claude-opus-4-5",
        modelProvider: "",
        reasoning: "high",
      },
    });
    const ownedChanged = makeAgent({ id: "a2" });
    const ownedFails = makeAgent({ id: "a3" });
    const othersAgent = makeAgent({ id: "a4", ownerId: "other-user" });

    const f = createFixture([ownedSame, ownedChanged, ownedFails, othersAgent], {
      supportsPush: true,
      runningAgentIds: new Set(["a1", "a2", "a3"]),
      failWriteIds: new Set(["a3"]),
    });

    const result = await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1", "a2", "a3", "a4"],
      runtime: {
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
        model: "claude-opus-4-5",
        modelProvider: "",
        reasoning: "high",
      },
    });

    expect(result.succeeded).toEqual([{ agentId: "a2", restart: "when-idle" }]);
    expect(result.skipped).toEqual([
      { agentId: "a1", reason: "unchanged" },
      { agentId: "a4", reason: "not-owner" },
    ]);
    expect(result.failed).toEqual([{ agentId: "a3", errorId: "agent-update-failed" }]);
  });

  test("listEnvironmentKeys returns sorted key names per owned Agent without ever exposing values", async () => {
    const a1 = makeAgent({ id: "a1" });
    const a2 = makeAgent({ id: "a2" });
    const foreign = makeAgent({ id: "a3", ownerId: "other-user" });
    const f = createFixture([a1, a2, foreign]);

    await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1"],
      environmentPatch: { set: { SECRET_TOKEN: "top-secret-value", NODE_ENV: "dev" }, remove: [] },
    });
    await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a2"],
      environmentPatch: { set: { NODE_ENV: "test" }, remove: [] },
    });

    const keys = await f.service.listEnvironmentKeys(principal, "computer-1", ["a1", "a2", "a3"]);
    expect(keys).toEqual({
      a1: ["NODE_ENV", "SECRET_TOKEN"],
      a2: ["NODE_ENV"],
    });
    expect(JSON.stringify(keys)).not.toContain("top-secret-value");
  });

  test("rejects conflicting environment patch keys and empty payloads", async () => {
    const f = createFixture([makeAgent({ id: "a1" })]);

    await expect(
      f.service.apply(principal, {
        computerId: "computer-1",
        agentIds: ["a1"],
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INVALID_INPUT" });

    await expect(
      f.service.apply(principal, {
        computerId: "computer-1",
        agentIds: ["a1"],
        environmentPatch: {
          set: { HTTP_PROXY: "http://127.0.0.1:7890" },
          remove: ["HTTP_PROXY"],
        },
      }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "INVALID_INPUT",
      errorId: "agent-batch-env-conflict",
    });
  });

  test("preserves existing API key when updating within the same CoForge provider", async () => {
    const a1 = makeAgent({
      id: "a1",
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: {
          kind: "coforge",
          providerId: "openrouter",
          apiKey: { keyId: "v1", ciphertext: "existing", nonce: "n", hint: "...1234" },
        },
        model: "anthropic/claude-sonnet-4.5",
        modelProvider: "openrouter",
        reasoning: "medium",
      },
    });
    const f = createFixture([a1], { supportsPush: true, runningAgentIds: new Set(["a1"]) });

    const result = await f.service.apply(principal, {
      computerId: "computer-1",
      agentIds: ["a1"],
      runtime: {
        provider: RUNTIME_PROVIDER.COFORGE,
        modelProvider: "openrouter",
        model: "openai/gpt-5.3",
        reasoning: "high",
      },
    });

    expect(result.succeeded).toEqual([{ agentId: "a1", restart: "when-idle" }]);
    const saved = f.byId.get("a1")!.runtimeConfig!;
    expect(saved.provider).toEqual({
      kind: "coforge",
      providerId: "openrouter",
      apiKey: { keyId: "v1", ciphertext: "existing", nonce: "n", hint: "...1234" },
    });
  });
});
