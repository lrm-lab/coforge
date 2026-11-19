import { describe, expect, test } from "bun:test";
import {
  AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
  AGENT_SIDE_ASK_FORK_MAX_CONTEXT_TOKENS,
  AGENT_SIDE_ASK_RESULT_METHOD,
  decodeAgentSideAskResult,
  encodeAgentSideAskRequest,
  RUNTIME_PROVIDER,
  type AgentSideAskRequest,
  type AgentSideAskResult,
} from "@lrm/coforge-sdk/internal";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { DaemonQueries } from "#src/connection/daemon-queries";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import {
  subscribeAgentSideAskQueries,
  type AgentSideAskSource,
} from "#src/daemon-runtime/agent-side-ask-handler";

function sampleRequest(overrides: Partial<AgentSideAskRequest> = {}): AgentSideAskRequest {
  return {
    protocolMajor: 1,
    requestId: "sask_0123456789abcdef0123456789abcdef",
    workspaceId: "ws-1",
    computerId: "comp-1",
    agentId: "agent-1",
    kind: "question",
    question: "Which test file are you working on?",
    timeoutMs: AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
    asker: {
      userId: "user-1",
      displayName: "Frank",
      role: "owner",
      isAgentOwner: true,
    },
    ...overrides,
  };
}

describe("subscribeAgentSideAskQueries and DaemonQueries", () => {
  test("DaemonQueries decodes requests and encodes results on AGENT_SIDE_ASK_RESULT_METHOD", async () => {
    const sent: Array<{ method: string; bytes: Uint8Array }> = [];
    const queries = new DaemonQueries(async (method, bytes) => {
      sent.push({ method, bytes });
    });
    const received: AgentSideAskRequest[] = [];
    queries.agentSideAsk.onRequest(async (req) => {
      received.push(req);
      await queries.agentSideAsk.sendResult({
        protocolMajor: 1,
        requestId: req.requestId,
        workspaceId: req.workspaceId,
        computerId: req.computerId,
        agentId: req.agentId,
        askerUserId: req.asker.userId,
        kind: req.kind,
        status: "ok",
        answer: "State: idle [codex]",
        runtime: "codex",
        durationMs: 5,
      });
    });

    const req = sampleRequest({ kind: "status", question: "" });
    const matched = queries.receive(encodeAgentSideAskRequest(req), {
      workspaceId: "ws-1",
      computerId: "comp-1",
    });
    expect(matched).toBe(true);
    await Bun.sleep(5);
    expect(received).toEqual([req]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe(AGENT_SIDE_ASK_RESULT_METHOD);
    expect(decodeAgentSideAskResult(sent[0]!.bytes).answer).toBe("State: idle [codex]");
  });

  test("handles status across runtimes and enforces question guardrails", async () => {
    let listener: ((req: AgentSideAskRequest) => Promise<void>) | undefined;
    const results: AgentSideAskResult[] = [];
    const transport = {
      onAgentSideAsk: (cb: (req: AgentSideAskRequest) => Promise<void>) => {
        listener = cb;
        return () => {};
      },
      sendAgentSideAskResult: async (result: AgentSideAskResult) => {
        results.push(result);
      },
    } as unknown as DaemonConnectionClient;

    let provider: "claude-code" | "codex" = RUNTIME_PROVIDER.CODEX;
    let isHeld = false;
    let isRunning = true;
    let isStopping = false;
    let stopDuringRead = false;
    let lastContextTokens: number | undefined;
    let hasTranscript = true;
    const ledger = new ToolCallLedger(() => 10_000);
    ledger.observe({ type: "tool-start", id: "t1", name: "Bash" });
    const launch: ActivityLaunch = {
      launchId: "launch-1",
      clientSeq: 1,
      stopping: false,
      toolCalls: ledger,
      get lastContextTokens() {
        return lastContextTokens;
      },
    };
    const activeRuntime = {
      get config() {
        return { provider, model: "claude-sonnet-4-6" };
      },
      session: {},
    };
    let restartSessionId: string | undefined = "sess-live";
    let reportedSession: Readonly<{ launchId: string; sessionId: string }> | undefined;
    let askCalls = 0;
    const source: AgentSideAskSource = {
      runtime: () => (isRunning ? (activeRuntime as never) : undefined),
      restartConfig: () => ({ config: { provider }, sessionId: restartSessionId }) as never,
      currentActivityLaunch: () => (isRunning ? launch : undefined),
      stopping: () => isStopping,
      reported: () => reportedSession,
      onRuntimeEnd: () => () => {},
    };

    subscribeAgentSideAskQueries(transport, {
      connection: {
        workspaceId: "ws-1",
        computerId: "comp-1",
        workspaceRoot: "/tmp/ws",
      },
      source,
      activityPublisher: {
        lastBusy: () => ({
          launch,
          activity: {
            protocolMajor: 1,
            requestId: "act-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            detailKind: "running_command",
            level: "info",
            detail: "Running tests",
          },
          at: 1_000,
        }),
      },
      credentialHolds: { isHeld: () => isHeld },
      quotaState: {
        summaryForAgent: (_agentId, activeProvider) =>
          activeProvider === RUNTIME_PROVIDER.CODEX
            ? {
                provider: RUNTIME_PROVIDER.CODEX,
                window: "primary",
                windowDurationMinutes: 300,
                level: "warning",
                usedPercent: 84,
                observedAtMs: 4_000,
              }
            : undefined,
      },
      runner: {
        hasInFlight: () => false,
        ask: async () => {
          askCalls += 1;
          return { ok: true, answer: "Editing daemon-queries.ts" };
        },
      },
      currentTransport: () => transport,
      isStopping: () => false,
      readClaudeState: async () => {
        if (stopDuringRead) isStopping = true;
        return hasTranscript
          ? {
              transcriptPath: "/tmp/sess-live.jsonl",
              openTodos: [{ content: "Finish P3", status: "in_progress" }],
              openTodoCount: 1,
              totalTodos: 1,
              latestNote: "Almost done",
              contextTokens: 120_000,
            }
          : undefined;
      },
      now: () => 5_000,
    });

    await listener!(sampleRequest({ kind: "status", question: "" }));
    expect(results.at(-1)?.status).toBe("ok");
    expect(results.at(-1)?.answer).toContain("State: working (running_command, 4s) [codex]");
    expect(results.at(-1)?.answer).toContain("Running tool: Bash");
    expect(results.at(-1)?.answer).toContain("Quota: warning (5h window, 84%)");

    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "unsupported_runtime" });

    provider = RUNTIME_PROVIDER.CLAUDE_CODE;
    isHeld = true;
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "usage_limited" });

    isHeld = false;
    hasTranscript = false;
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "agent_not_running" });

    hasTranscript = true;
    restartSessionId = undefined;
    reportedSession = { launchId: "launch-old", sessionId: "sess-stale" };
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "agent_not_running" });

    reportedSession = { launchId: "launch-1", sessionId: "sess-live" };
    lastContextTokens = AGENT_SIDE_ASK_FORK_MAX_CONTEXT_TOKENS + 1;
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "context_too_large" });

    lastContextTokens = 200_000;
    stopDuringRead = true;
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "agent_not_running" });
    expect(askCalls).toBe(0);

    stopDuringRead = false;
    isStopping = false;
    await listener!(sampleRequest({ kind: "question" }));
    expect(results.at(-1)).toMatchObject({
      status: "ok",
      answer: "Editing daemon-queries.ts",
      runtime: "claude-code",
      askerUserId: "user-1",
    });
    expect(askCalls).toBe(1);

    isRunning = false;
    await listener!(sampleRequest({ kind: "status", question: "" }));
    expect(results.at(-1)).toMatchObject({ status: "failed", reason: "agent_not_running" });
  });
});
