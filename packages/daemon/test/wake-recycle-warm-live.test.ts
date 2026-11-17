import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type { AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import type { IdleNudgeRequest } from "#src/daemon-runtime/task-idle-nudge";
import {
  selectColdIdleStops,
  type ColdIdleSweepView,
} from "#src/agent-runtime/wake-session-recycle";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-warm-live-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("selectColdIdleStops selects live bloated sessions (>500k immediate and >250k after 2m quiet) while keeping recent warm sessions", async () => {
  const base: ColdIdleSweepView = {
    agentId: "agent-warm",
    provider: "codex",
    busyReason: undefined,
    supported: true,
    providerMinColdGapMs: 30 * MINUTE,
    sessionId: "session-warm-1",
    lastEventAtMs: NOW - 3 * MINUTE,
    lastContextTokens: 280_000,
  };

  const warmStop = await selectColdIdleStops([base], {
    nowMs: NOW,
    processEnv: {},
    readFacts: async () => ({ lastActivityAtMs: NOW - 3 * MINUTE, lastContextTokens: 280_000 }),
  });
  expect(warmStop).toEqual([
    {
      agentId: "agent-warm",
      sessionId: "session-warm-1",
      idleMs: 3 * MINUTE,
      priorContextTokens: 280_000,
    },
  ]);

  const warmRecent = await selectColdIdleStops([{ ...base, lastEventAtMs: NOW - MINUTE }], {
    nowMs: NOW,
    processEnv: {},
    readFacts: async () => ({ lastActivityAtMs: NOW - MINUTE, lastContextTokens: 280_000 }),
  });
  expect(warmRecent).toEqual([]);

  const immediateStop = await selectColdIdleStops(
    [{ ...base, lastEventAtMs: NOW - 5_000, lastContextTokens: 520_000 }],
    {
      nowMs: NOW,
      processEnv: {},
      readFacts: async () => ({ lastActivityAtMs: NOW - 5_000, lastContextTokens: 520_000 }),
    },
  );
  expect(immediateStop).toEqual([
    {
      agentId: "agent-warm",
      sessionId: "session-warm-1",
      idleMs: 5_000,
      priorContextTokens: 520_000,
    },
  ]);
});

test("TurnEndCompaction re-invokes TaskIdleNudge with freshSession:true after compaction settles, and Claude /compact avoids zero-evidence errors and loops", async () => {
  await captureDaemonLogs(async () => {
    const nudgeRequests: Array<{ agentId: string; request: IdleNudgeRequest }> = [];
    const activities: AgentActivity[] = [];
    const claudeMessages: string[] = [];
    let piListener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    let claudeListener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    let piLive = false;
    let claudeLive = false;

    const piProvider: CodeAgentProvider = {
      provider: "pi",
      reportsCompaction: true,
      async createAgentSession(options) {
        await options.onSessionId?.("pi-session-1");
        return {
          get hasLiveTurn() {
            return piLive;
          },
          async sendMessage() {
            piLive = true;
            piListener({ type: "text-delta", text: "boot" });
            piLive = false;
            piListener({ type: "completed", status: "completed" });
          },
          async notify() {
            piLive = true;
            piListener({ type: "text-delta", text: "ack nudge" });
            piLive = false;
            piListener({ type: "completed", status: "completed" });
          },
          async compact() {
            piLive = true;
            await Bun.sleep(10);
            piListener({ type: "compaction-started" });
            piListener({ type: "context-usage", usedTokens: 45_000, windowTokens: 400_000 });
            piListener({
              type: "compaction-finished",
              tokensBefore: 270_000,
              tokensAfter: 45_000,
            });
            piLive = false;
          },
          subscribe(next) {
            piListener = next;
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

    const claudeProvider: CodeAgentProvider = {
      provider: "claude-code",
      reportsCompaction: true,
      async createAgentSession(options) {
        await options.onSessionId?.("claude-session-1");
        return {
          get hasLiveTurn() {
            return claudeLive;
          },
          async sendMessage(text) {
            claudeMessages.push(text);
            claudeLive = true;
            if (text === "/compact") {
              setTimeout(() => {
                claudeListener({
                  type: "context-usage",
                  usedTokens: 255_000,
                  windowTokens: 500_000,
                });
                claudeLive = false;
                claudeListener({ type: "completed", status: "completed" });
              }, 15);
              return;
            }
            claudeListener({ type: "text-delta", text: "claude boot" });
            claudeLive = false;
            claudeListener({ type: "completed", status: "completed" });
          },
          async notify() {},
          subscribe(next) {
            claudeListener = next;
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
      computerId: "computer-post-compact",
      workspaceId: "workspace-post-compact",
      workspaceRoot: join(tempDir, "workspace"),
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      (p) => (p === "claude-code" ? claudeProvider : piProvider),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async reportAgentSession() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig(req) {
            return {
              agentApiKey: `sk_agent_${req.agentId.padEnd(43, "a").slice(0, 43)}`,
            };
          },
          async revokeAgentApiKey() {},
          async agentTaskIdleNudge(request, apiKey) {
            const agentId = apiKey.includes("agent-claude") ? "agent-claude" : "agent-pi";
            nudgeRequests.push({ agentId, request });
            return { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      join(tempDir, "state"),
    );

    await runtime.start(connection);
    try {
      await runtime.startAgent("agent-pi", {
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
      });
      await Bun.sleep(20);
      nudgeRequests.length = 0;

      piLive = true;
      piListener({ type: "context-usage", usedTokens: 270_000, windowTokens: 400_000 });
      piListener({ type: "text-delta", text: "work done" });
      piLive = false;
      piListener({ type: "completed", status: "completed" });

      for (
        let i = 0;
        i < 40 && nudgeRequests.filter((r) => r.agentId === "agent-pi").length === 0;
        i++
      ) {
        await Bun.sleep(10);
      }
      const piNudges = nudgeRequests.filter((r) => r.agentId === "agent-pi");
      expect(piNudges).toHaveLength(1);
      expect(piNudges[0]?.request.freshSession).toBe(true);

      await runtime.startAgent("agent-claude", {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        reasoning: "balanced",
      });
      await Bun.sleep(20);
      activities.length = 0;
      nudgeRequests.length = 0;
      claudeMessages.length = 0;

      claudeLive = true;
      claudeListener({ type: "context-usage", usedTokens: 260_000, windowTokens: 500_000 });
      claudeListener({ type: "text-delta", text: "claude work" });
      claudeLive = false;
      claudeListener({ type: "completed", status: "completed" });

      for (
        let i = 0;
        i < 40 && nudgeRequests.filter((r) => r.agentId === "agent-claude").length === 0;
        i++
      ) {
        await Bun.sleep(10);
      }

      expect(claudeMessages.filter((m) => m === "/compact")).toHaveLength(1);
      expect(nudgeRequests.filter((r) => r.agentId === "agent-claude")).toHaveLength(1);
      expect(
        activities.filter((a) => a.agentId === "agent-claude" && a.detailKind === "runtime_error"),
      ).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
});

test("live sessions recycle immediately past 500k tokens and after warmQuietMs past 250k tokens before the next message arrives", async () => {
  await captureDaemonLogs(async () => {
    const sessionsCreated: Array<{ agentId?: string; sessionId?: string; sessionMode?: string }> =
      [];
    const prompts: string[] = [];
    const listeners = new Map<string, Parameters<AgentSession["subscribe"]>[0]>();
    const liveMap = new Map<string, boolean>();
    let lastTokens = 520_000;
    let lastActivityDeltaMs = 1_000;

    const codexProvider: CodeAgentProvider = {
      provider: "codex",
      idleRecycleMinColdGapMs: 30 * MINUTE,
      async readSessionResumeFacts() {
        return {
          lastActivityAtMs: Date.now() - lastActivityDeltaMs,
          lastContextTokens: lastTokens,
        };
      },
      async readRecycleBriefing() {
        return `<prior-session-briefing>live ${String(lastTokens)} summary</prior-session-briefing>`;
      },
      async createAgentSession(options) {
        const idx = sessionsCreated.length + 1;
        const agentId = options.agentWorkspaceDirectory.includes("agent-warm-280k")
          ? "agent-warm-280k"
          : "agent-codex";
        sessionsCreated.push({
          agentId,
          sessionId: options.sessionId,
          sessionMode: options.sessionMode,
        });
        const assignedId =
          options.sessionMode === "resume" && options.sessionId
            ? options.sessionId
            : `${agentId}-session-${idx}`;
        await options.onSessionId?.(assignedId);
        const myExits = new Set<() => void>();
        return {
          get hasLiveTurn() {
            return liveMap.get(agentId) === true;
          },
          async sendMessage(text) {
            prompts.push(`${agentId}:${text}`);
            liveMap.set(agentId, true);
            listeners.get(agentId)?.({ type: "text-delta", text: "started" });
            liveMap.set(agentId, false);
            listeners.get(agentId)?.({ type: "completed", status: "completed" });
          },
          async notify(text) {
            prompts.push(`${agentId}:notify:${text}`);
          },
          subscribe(next) {
            listeners.set(agentId, next);
            return () => undefined;
          },
          async interrupt() {},
          onExit(next) {
            const fn = () => next();
            myExits.add(fn);
            return () => myExits.delete(fn);
          },
          async dispose() {
            for (const fn of myExits) fn();
          },
        };
      },
    };

    const connection = {
      computerId: "computer-live-recycle",
      workspaceId: "workspace-live-recycle",
      workspaceRoot: join(tempDir, "workspace-recycle"),
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => codexProvider,
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async reportAgentSession() {},
          async sendAgentDeliveryAck() {},
          async requestAgentLaunchConfig(req) {
            return {
              agentApiKey: `sk_agent_${req.agentId.padEnd(43, "b").slice(0, 43)}`,
              ...(req.agentId === "agent-warm-280k"
                ? { envVars: { COFORGE_WAKE_RECYCLE_WARM_QUIET_MS: "40" } }
                : {}),
            };
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      join(tempDir, "state-recycle"),
    );

    await runtime.start(connection);
    try {
      await runtime.startAgent("agent-codex", {
        provider: "codex",
        model: "gpt-5",
        reasoning: "balanced",
      });
      expect(sessionsCreated.filter((s) => s.agentId === "agent-codex")).toHaveLength(1);

      lastTokens = 520_000;
      lastActivityDeltaMs = 1_000;
      liveMap.set("agent-codex", true);
      listeners.get("agent-codex")!({
        type: "context-usage",
        usedTokens: 520_000,
        windowTokens: 1_000_000,
      });
      listeners.get("agent-codex")!({ type: "text-delta", text: "huge turn finished" });
      liveMap.set("agent-codex", false);
      listeners.get("agent-codex")!({ type: "completed", status: "completed" });

      for (let i = 0; i < 40 && runtime.runtime("agent-codex") !== undefined; i++) {
        await Bun.sleep(10);
      }
      expect(runtime.runtime("agent-codex")).toBeUndefined();

      await runtime.handleAgentMessage({
        protocolMajor: 1,
        method: "agent:v1:message:deliver",
        requestId: "req-after-520k",
        messageId: "msg-after-520k",
        deliveryId: "del-after-520k",
        workspaceId: connection.workspaceId,
        agentId: "agent-codex",
        conversationId: "conv-1",
        target: "#general",
        sequence: 1,
        body: "next task",
      });
      for (
        let i = 0;
        i < 40 && sessionsCreated.filter((s) => s.agentId === "agent-codex").length < 2;
        i++
      ) {
        await Bun.sleep(10);
      }
      expect(sessionsCreated.filter((s) => s.agentId === "agent-codex")).toHaveLength(2);
      expect(prompts.some((p) => p.includes("live 520000 summary"))).toBe(true);

      await runtime.startAgent("agent-warm-280k", {
        provider: "codex",
        model: "gpt-5",
        reasoning: "balanced",
      });
      lastTokens = 280_000;
      lastActivityDeltaMs = 60;
      liveMap.set("agent-warm-280k", true);
      listeners.get("agent-warm-280k")!({
        type: "context-usage",
        usedTokens: 280_000,
        windowTokens: 1_000_000,
      });
      listeners.get("agent-warm-280k")!({ type: "text-delta", text: "warm turn finished" });
      liveMap.set("agent-warm-280k", false);
      listeners.get("agent-warm-280k")!({ type: "completed", status: "completed" });

      for (let i = 0; i < 60 && runtime.runtime("agent-warm-280k") !== undefined; i++) {
        await Bun.sleep(10);
      }
      expect(runtime.runtime("agent-warm-280k")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});
