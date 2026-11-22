import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@logtape/logtape";
import {
  RUNTIME_PROVIDER,
  type AgentSessionReport,
  type AgentStartIntent,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent, AgentSessionOptions, CodeAgentProvider } from "@lrm/coforge-anvil";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { supportsSessionResume } from "#src/daemon-runtime/cold-idle-sweep";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { AgentStateDb, writeMeta } from "#src/persistence/agent-state-db";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const START = new Date("2026-11-19T00:00:00.000Z");
const minutes = (count: number) => new Date(START.getTime() + count * 60_000);
const SWEEP_MS = "COFORGE_WAKE_RECYCLE_SWEEP_MS";

let tempDir: string;
let savedSweepMs: string | undefined;

beforeEach(async () => {
  savedSweepMs = Bun.env[SWEEP_MS];
  delete Bun.env[SWEEP_MS];
  tempDir = await mkdtemp(join(tmpdir(), "coforge-summary-recycle-"));
});

afterEach(async () => {
  setSystemTime();
  if (savedSweepMs === undefined) delete Bun.env[SWEEP_MS];
  else Bun.env[SWEEP_MS] = savedSweepMs;
  await rm(tempDir, { recursive: true, force: true });
});

async function waitForLog(
  records: readonly LogRecord[],
  match: (record: LogRecord) => boolean,
): Promise<LogRecord> {
  while (!records.some(match)) await Bun.sleep(1);
  return records.find(match)!;
}

const sweepWith = (stops: number) => (record: LogRecord) =>
  record.properties.event === "agent.runtime.cold_idle_sweep" && record.properties.stops === stops;

const sweepAfterLaunch = (record: LogRecord) =>
  record.properties.event === "agent.runtime.cold_idle_sweep" &&
  !("skipped_not_launched" in record.properties);

test("shipped provider registry enables idle recycle for Raft-aligned runtimes plus Antigravity", () => {
  const enabled: RuntimeProvider[] = [
    RUNTIME_PROVIDER.CLAUDE_CODE,
    RUNTIME_PROVIDER.CODEX,
    RUNTIME_PROVIDER.PI,
    RUNTIME_PROVIDER.COFORGE,
    RUNTIME_PROVIDER.GROK,
    RUNTIME_PROVIDER.OPENCODE,
    RUNTIME_PROVIDER.ANTIGRAVITY,
  ];
  const disabled: RuntimeProvider[] = [
    RUNTIME_PROVIDER.KIRO,
    RUNTIME_PROVIDER.CURSOR,
    RUNTIME_PROVIDER.DSH,
    RUNTIME_PROVIDER.COMMAND_CODE,
    RUNTIME_PROVIDER.DEVIN,
    RUNTIME_PROVIDER.DROID,
  ];

  for (const name of enabled) {
    const provider = createCodeAgentProvider(name);
    expect(supportsSessionResume(provider)).toBe(true);
  }
  for (const name of disabled) {
    const provider = createCodeAgentProvider(name);
    expect(supportsSessionResume(provider)).toBe(false);
  }
});

async function createRuntimeHarness(options: {
  provider: RuntimeProvider;
  nativeFacts?: CodeAgentProvider["readSessionResumeFacts"];
}) {
  setSystemTime(START);
  const connection: DaemonConfig = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: join(tempDir, "workspaces"),
  };
  const stateDir = join(tempDir, "state");
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  const agentDir = agentWorkspaceDirectory(
    connection.workspaceRoot,
    connection.workspaceId,
    "agent-a",
  );
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n- summary recycle fact\n");

  const sessions: Array<{
    options: AgentSessionOptions;
    inputs: string[];
    disposed: boolean;
    emit(event: AgentRuntimeEvent): void;
    runTurn(fn: (emit: (event: AgentRuntimeEvent) => void) => void): void;
  }> = [];
  const reports: AgentSessionReport[] = [];

  const provider: CodeAgentProvider = {
    provider: options.provider,
    supportsSessionSummaryRecycle: true,
    ...(options.nativeFacts ? { readSessionResumeFacts: options.nativeFacts } : {}),
    async createAgentSession(sessionOptions) {
      const listeners = new Set<(event: AgentRuntimeEvent) => void>();
      const exitListeners = new Set<() => void>();
      let liveTurn = false;
      const emit = (event: AgentRuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };
      const record = {
        options: sessionOptions,
        inputs: [] as string[],
        disposed: false,
        emit,
        runTurn(fn: (emitEvent: (event: AgentRuntimeEvent) => void) => void) {
          liveTurn = true;
          emit({ type: "text-delta", text: "working" });
          fn(emit);
          liveTurn = false;
          emit({ type: "completed", status: "completed" });
        },
      };
      sessions.push(record);
      await sessionOptions.onSessionId?.(sessionOptions.sessionId ?? `native-${sessions.length}`);
      return {
        get hasLiveTurn() {
          return liveTurn;
        },
        async sendMessage(text) {
          record.inputs.push(text);
          emit({ type: "text-delta", text: "ok" });
          emit({ type: "completed", status: "completed" });
        },
        async notify(text) {
          record.inputs.push(text);
          liveTurn = true;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async interrupt() {},
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async dispose() {
          record.disposed = true;
          for (const listener of Array.from(exitListeners)) listener();
        },
      };
    },
  };

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
          return {
            agentApiKey: `sk_agent_${"a".repeat(43)}`,
            envVars: {},
          };
        },
        async revokeAgentApiKey() {},
        async reportAgentSession(report) {
          reports.push(report);
        },
        sendAgentActivity() {},
        sendAgentStatus() {},
        sendAgentContextUsage() {},
        async sendAgentControlResult() {},
        async sendAgentDeliveryAck() {},
        async sendAgentDeliveryRejection() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDir,
  );
  await runtime.start(connection);

  const intent = (overrides: Partial<AgentStartIntent> = {}): AgentStartIntent => ({
    protocolMajor: 1,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    requestId: "start-1",
    controlEpoch: 1,
    launchId: "launch-1",
    provider: options.provider,
    model: "default",
    modelProvider: "google",
    reasoning: "balanced",
    ...overrides,
  });

  const deliver = async (sequence: number) => {
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: `request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: `body-${sequence}`,
      method: "agent:v1:message:deliver",
      target: "#general",
      mentionsAgent: true,
    });
  };

  return { runtime, sessions, reports, intent, deliver };
}

test.each<RuntimeProvider>([
  RUNTIME_PROVIDER.ANTIGRAVITY,
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.COFORGE,
])(
  "%s stops when cold and large using persisted session summary and recycles with MEMORY.md on wake",
  async (runtimeProvider) => {
    Bun.env[SWEEP_MS] = "5";
    const { result: h, records } = await captureDaemonLogs(async (records) => {
      const h = await createRuntimeHarness({ provider: runtimeProvider });
      try {
        await h.runtime.handleAgentStart(h.intent());
        h.sessions[0]!.runTurn((emit) => {
          emit({
            type: "context-usage",
            usedTokens: 200_000,
            windowTokens: 400_000,
          });
        });

        setSystemTime(minutes(90));
        await waitForLog(records, sweepWith(1));
        expect(h.sessions[0]!.disposed).toBe(true);

        await h.deliver(1);
        return h;
      } finally {
        await h.runtime.stop();
      }
    });

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.options.sessionId).toBeUndefined();
    expect(h.sessions[1]!.options.sessionMode).toBe("create");
    expect(h.reports.at(-1)).toMatchObject({
      sessionId: "native-2",
      replacedSessionId: "native-1",
    });
    expect(h.sessions[1]!.inputs[0]).toContain("<memory-index>");
    expect(h.sessions[1]!.inputs[0]).toContain("summary recycle fact");
    expect(records.some((r) => r.properties.event === "agent.runtime.cold_idle_stop")).toBe(true);
    expect(records.some((r) => r.properties.event === "agent.runtime.wake_recycle")).toBe(true);
  },
);

test("compaction clears stale session summary context tokens so a compacted session is not falsely recycled", async () => {
  Bun.env[SWEEP_MS] = "5";
  await captureDaemonLogs(async (records) => {
    const h = await createRuntimeHarness({ provider: RUNTIME_PROVIDER.GROK });
    try {
      await h.runtime.handleAgentStart(h.intent());
      h.sessions[0]!.runTurn((emit) => {
        emit({
          type: "context-usage",
          usedTokens: 220_000,
          windowTokens: 256_000,
        });
        emit({ type: "compaction-started" });
        emit({ type: "compaction-finished" });
      });

      setSystemTime(minutes(90));
      const sweep = await waitForLog(records, sweepAfterLaunch);
      expect(sweep.properties).toMatchObject({
        agents: 1,
        stops: 0,
        skipped_session_facts_unavailable: 1,
      });
      expect(h.sessions[0]!.disposed).toBe(false);
    } finally {
      await h.runtime.stop();
    }
  });
});

async function codexInputOnlyRollout() {
  const codexHome = join(tempDir, "codex");
  const directory = join(codexHome, "sessions", "2026", "11", "19");
  await mkdir(directory, { recursive: true });
  const lines = [{ input_tokens: 200_000, total_tokens: 210_000 }, { input_tokens: 170_000 }].map(
    (last_token_usage, index) =>
      JSON.stringify({
        timestamp: minutes(index).toISOString(),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage } },
      }),
  );
  lines.push(
    JSON.stringify({
      timestamp: minutes(3).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 1 } } },
    }),
  );
  await writeFile(
    join(directory, "rollout-2026-11-19T00-00-00-native-1.jsonl"),
    lines.join("\n") + "\n",
  );
  const codex = createCodeAgentProvider(RUNTIME_PROVIDER.CODEX);
  return ({ sessionId }: { sessionId: string }) =>
    codex.readSessionResumeFacts!({
      sessionId,
      envVars: { CODEX_HOME: codexHome },
    });
}

test.each([
  ["no reading", false],
  ["an earlier reading", true],
] as const)(
  "Codex sweep skips an input-only latest request with %s in its summary",
  async (_summary, earlierReading) => {
    Bun.env[SWEEP_MS] = "5";
    const nativeFacts = await codexInputOnlyRollout();
    await captureDaemonLogs(async (records) => {
      const h = await createRuntimeHarness({ provider: RUNTIME_PROVIDER.CODEX, nativeFacts });
      try {
        await h.runtime.handleAgentStart(h.intent());
        if (earlierReading) {
          h.sessions[0]!.runTurn((emit) =>
            emit({ type: "context-usage", usedTokens: 210_000, windowTokens: 400_000 }),
          );
          setSystemTime(minutes(2));
          h.sessions[0]!.runTurn(() => {});
        }
        setSystemTime(minutes(90));
        const sweep = await waitForLog(records, sweepAfterLaunch);
        expect(sweep.properties).toMatchObject({
          stops: 0,
          skipped_session_facts_unavailable: 1,
        });
        expect(h.sessions[0]!.disposed).toBe(false);
      } finally {
        await h.runtime.stop();
      }
    });
  },
);

test.each([
  ["no reading", false],
  ["an untimed legacy reading", true],
] as const)(
  "Codex wake resumes the original thread with %s in its summary",
  async (_summary, legacySummary) => {
    const nativeFacts = await codexInputOnlyRollout();
    await captureDaemonLogs(async (records) => {
      const h = await createRuntimeHarness({ provider: RUNTIME_PROVIDER.CODEX, nativeFacts });
      try {
        if (legacySummary) {
          const db = AgentStateDb.open(join(tempDir, "state"), "agent-a");
          try {
            writeMeta(
              db.database,
              "sessionSummary",
              JSON.stringify({
                sessionId: "native-1",
                provider: RUNTIME_PROVIDER.CODEX,
                lastActivityAtMs: minutes(2).getTime(),
                lastContextTokens: 210_000,
                updatedAtMs: minutes(2).getTime(),
              }),
            );
          } finally {
            db.close();
          }
        }
        setSystemTime(minutes(90));
        await h.runtime.handleAgentStart(
          h.intent({ sessionId: "native-1", sessionMode: "resume" }),
        );
        expect(h.sessions[0]?.options.sessionId).toBe("native-1");
        expect(h.sessions[0]?.options.sessionMode).toBe("resume");
        expect(
          records.find((r) => r.properties.event === "agent.runtime.wake_recycle")?.properties,
        ).toMatchObject({ outcome: "resume", reason: "session_facts_unavailable" });
      } finally {
        await h.runtime.stop();
      }
    });
  },
);

test.each(["missing rollout", "input-only latest request"] as const)(
  "Codex uses its session summary with %s",
  async (rollout) => {
    const nativeFacts =
      rollout === "missing rollout" ? async () => undefined : await codexInputOnlyRollout();
    Bun.env[SWEEP_MS] = "5";
    const { result: h } = await captureDaemonLogs(async (records) => {
      const h = await createRuntimeHarness({
        provider: RUNTIME_PROVIDER.CODEX,
        nativeFacts,
      });
      try {
        await h.runtime.handleAgentStart(h.intent());
        setSystemTime(minutes(1));
        h.sessions[0]!.runTurn((emit) => {
          emit({
            type: "context-usage",
            usedTokens: 190_000,
            windowTokens: 400_000,
          });
        });

        setSystemTime(minutes(90));
        await waitForLog(records, sweepWith(1));
        expect(h.sessions[0]!.disposed).toBe(true);

        await h.deliver(1);
        expect(
          records.find((r) => r.properties.event === "agent.runtime.cold_idle_stop")?.properties,
        ).toMatchObject({ prior_context_tokens: 190_000 });
        expect(
          records.find((r) => r.properties.event === "agent.runtime.wake_recycle")?.properties,
        ).toMatchObject({ outcome: "recycle", prior_context_tokens: 190_000 });
        return h;
      } finally {
        await h.runtime.stop();
      }
    });

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.options.sessionId).toBeUndefined();
    expect(h.reports.at(-1)).toMatchObject({
      sessionId: "native-2",
      replacedSessionId: "native-1",
    });
  },
);

test("Antigravity recycles immediately on live warm bloat (>500k context) and respects explicit resumePrompt", async () => {
  Bun.env[SWEEP_MS] = "5";
  const { result: h } = await captureDaemonLogs(async (records) => {
    const h = await createRuntimeHarness({ provider: RUNTIME_PROVIDER.ANTIGRAVITY });
    try {
      await h.runtime.handleAgentStart(h.intent());
      h.sessions[0]!.runTurn((emit) => {
        emit({
          type: "context-usage",
          usedTokens: 520_000,
          windowTokens: 1_000_000,
        });
      });

      await waitForLog(records, sweepWith(1));
      expect(h.sessions[0]!.disposed).toBe(true);

      await h.runtime.handleAgentStart(
        h.intent({
          requestId: "start-2",
          controlEpoch: 2,
          launchId: "launch-2",
          sessionId: "native-1",
          sessionMode: "resume",
          resumePrompt: "keep this session",
        }),
      );
      return h;
    } finally {
      await h.runtime.stop();
    }
  });

  expect(h.sessions).toHaveLength(2);
  expect(h.sessions[1]!.options.sessionId).toBe("native-1");
  expect(h.sessions[1]!.options.sessionMode).toBe("resume");
});
