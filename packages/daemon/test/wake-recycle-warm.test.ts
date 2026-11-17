import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import { readCodexRecycleBriefing } from "@lrm/coforge-anvil/codex";
import {
  decideWakeRecycle,
  resolveWakeRecycleConfig,
  resolveWarmRecycleConfig,
} from "#src/agent-runtime/wake-session-recycle";
import { codexHistoryHost } from "#src/code-agent/codex/history-host";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import {
  DEFAULT_IDLE_COMPACT_MIN_TOKENS,
  TurnEndCompaction,
} from "#src/daemon-runtime/turn-end-compaction";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-warm-recycle-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("decideWakeRecycle supports warm (>250k after 2m quiet) and immediate (>500k) session recycle", () => {
  const config = resolveWakeRecycleConfig({}, {});
  const warm = resolveWarmRecycleConfig({}, {});
  expect(warm).toEqual({
    warmMinContextTokens: 250_000,
    warmQuietMs: 2 * MINUTE,
    immediateContextTokens: 500_000,
  });

  // 280k tokens after 1m quiet (<= 2m): still warm, resumes.
  expect(
    decideWakeRecycle({
      config,
      warmConfig: warm,
      supported: true,
      sessionId: "s-warm-recent",
      hasResumePrompt: false,
      facts: { lastActivityAtMs: NOW - MINUTE, lastContextTokens: 280_000 },
      nowMs: NOW,
    }),
  ).toEqual({ action: "resume", reason: "cache_possibly_warm" });

  // 280k tokens after 3m quiet (> 2m): warm recycle triggers!
  expect(
    decideWakeRecycle({
      config,
      warmConfig: warm,
      supported: true,
      sessionId: "s-warm-ready",
      hasResumePrompt: false,
      facts: { lastActivityAtMs: NOW - 3 * MINUTE, lastContextTokens: 280_000 },
      nowMs: NOW,
    }),
  ).toEqual({
    action: "recycle",
    priorSessionId: "s-warm-ready",
    idleMs: 3 * MINUTE,
    priorContextTokens: 280_000,
  });

  // 520k tokens (> 500k) after only 10s quiet: immediate recycle triggers!
  expect(
    decideWakeRecycle({
      config,
      warmConfig: warm,
      supported: true,
      sessionId: "s-immediate",
      hasResumePrompt: false,
      facts: { lastActivityAtMs: NOW - 10_000, lastContextTokens: 520_000 },
      nowMs: NOW,
    }),
  ).toEqual({
    action: "recycle",
    priorSessionId: "s-immediate",
    idleMs: 10_000,
    priorContextTokens: 520_000,
  });
});

test("codexHistoryHost live re-read includes in-workspace files and rejects symlinks, outside, sensitive, and MEMORY.md paths", async () => {
  const codexHome = join(tempDir, "codex-home");
  const rolloutDir = join(codexHome, "sessions", "2026", "11", "17");
  const workspaceRoot = join(tempDir, "workspace");
  const outsideFile = join(tempDir, "outside-secret.txt");
  await mkdir(rolloutDir, { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });

  await writeFile(outsideFile, "OUTSIDE_SECRET_CONTENT", "utf8");
  await writeFile(join(workspaceRoot, "src", "live.ts"), "export const liveValue = 99;\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "target.ts"), "SYMLINK_TARGET_CONTENT\n", "utf8");
  await symlink(join(workspaceRoot, "src", "target.ts"), join(workspaceRoot, "src", "link.ts"));
  await writeFile(join(workspaceRoot, "MEMORY.md"), "PRIVATE_MEMORY_BLOCK\n", "utf8");
  await writeFile(join(workspaceRoot, ".env"), "API_TOKEN=topsecret\n", "utf8");

  const threadId = "22222222-3333-4444-8555-666666666666";
  const callLine = (ts: string, id: string, path: string) => [
    JSON.stringify({
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        arguments: JSON.stringify({ path }),
        call_id: id,
      },
    }),
    JSON.stringify({
      timestamp: ts,
      type: "response_item",
      payload: { type: "function_call_output", call_id: id, output: "stale transcript text" },
    }),
  ];

  const rollout = [
    ...callLine("2026-11-17T10:00:00.000Z", "c1", "src/live.ts"),
    ...callLine("2026-11-17T10:01:00.000Z", "c2", "src/link.ts"),
    ...callLine("2026-11-17T10:02:00.000Z", "c3", "../outside-secret.txt"),
    ...callLine("2026-11-17T10:03:00.000Z", "c4", "MEMORY.md"),
    ...callLine("2026-11-17T10:04:00.000Z", "c5", ".env"),
  ].join("\n");
  await writeFile(
    join(rolloutDir, `rollout-2026-11-17T10-00-00-${threadId}.jsonl`),
    `${rollout}\n`,
    "utf8",
  );

  const briefing = await readCodexRecycleBriefing(
    {
      sessionId: threadId,
      workingDirectory: workspaceRoot,
      budgetTokens: 8_000,
      envVars: { CODEX_HOME: codexHome },
    },
    codexHistoryHost,
  );

  expect(briefing).toContain("<objects-in-play>");
  expect(briefing).toContain("export const liveValue = 99;");
  expect(briefing).not.toContain("SYMLINK_TARGET_CONTENT");
  expect(briefing).not.toContain("OUTSIDE_SECRET_CONTENT");
  expect(briefing).not.toContain("PRIVATE_MEMORY_BLOCK");
  expect(briefing).not.toContain("API_TOKEN=topsecret");
});

test("TurnEndCompaction triggers native compaction at Working->Idle when context exceeds 250k once per generation", async () => {
  expect(DEFAULT_IDLE_COMPACT_MIN_TOKENS).toBe(250_000);
  let compacted = 0;
  let usedTokens = 200_000;
  let generation = 1;
  let idle = true;
  const compaction = new TurnEndCompaction({
    idle: () => idle,
    launchId: () => "launch-1",
    provider: () => "pi",
    envVars: () => undefined,
    contextTokens: () => usedTokens,
    contextGeneration: () => generation,
    needsSessionReset: () => false,
    canCompact: () => true,
    compact: async () => {
      compacted += 1;
    },
  });

  // Below threshold (200k <= 250k): does not compact.
  expect(compaction.maybeCompact("agent-a")).toBe(false);
  expect(compacted).toBe(0);

  // Above threshold (265k > 250k): compacts once for generation 1.
  usedTokens = 265_000;
  expect(compaction.maybeCompact("agent-a")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(compacted).toBe(1);

  // Same generation does not re-trigger idle compaction repeatedly.
  expect(compaction.maybeCompact("agent-a")).toBe(false);

  // Once contextGeneration advances, another >250k idle turn can compact again.
  generation = 2;
  expect(compaction.maybeCompact("agent-a")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(compacted).toBe(2);

  // Busy Agent never compacts.
  generation = 3;
  idle = false;
  expect(compaction.maybeCompact("agent-a")).toBe(false);
});

test("DaemonRuntime triggers proactive session.compact() at Working->Idle when context usage exceeds 250k", async () => {
  let compactCalls = 0;
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
  let live = false;
  const provider: CodeAgentProvider = {
    provider: "pi",
    reportsCompaction: true,
    async createAgentSession(options) {
      await options.onSessionId?.("native-pi-1");
      return {
        get hasLiveTurn() {
          return live;
        },
        async sendMessage() {
          live = true;
          listener({ type: "text-delta", text: "ready" });
          live = false;
          listener({ type: "completed", status: "completed" });
        },
        async notify() {
          live = true;
        },
        async compact() {
          compactCalls += 1;
          listener({ type: "compaction-started" });
          listener({
            type: "compaction-finished",
            tokensBefore: 270_000,
            tokensAfter: 45_000,
          });
        },
        subscribe(next) {
          listener = next;
          return () => undefined;
        },
        async interrupt() {},
        onExit() {
          return () => undefined;
        },
        async dispose() {},
      };
    },
  };

  const connection = {
    computerId: "computer-idle-compact",
    workspaceId: "workspace-idle-compact",
    workspaceRoot: join(tempDir, "rt-workspace"),
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  const { records } = await captureDaemonLogs(async () => {
    const runtime = new DaemonRuntime(
      connection,
      () => provider,
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      join(tempDir, "state"),
    );
    await runtime.start(connection);
    try {
      await runtime.startAgent("agent-a", {
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
      });

      // Simulate a heavy turn that ends idle at 270k input tokens.
      live = true;
      listener({ type: "context-usage", usedTokens: 270_000, windowTokens: 400_000 });
      listener({ type: "text-delta", text: "finished heavy turn" });
      live = false;
      listener({ type: "completed", status: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(compactCalls).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  expect(
    records.some((record) => record.properties.event === "agent.runtime.idle_compaction_started"),
  ).toBe(true);
});
