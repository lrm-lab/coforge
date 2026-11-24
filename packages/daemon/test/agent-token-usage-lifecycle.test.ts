import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession, AgentSessionExit } from "@lrm/coforge-anvil";
import type { AgentTokenUsage } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(
  realpathSync(tmpdir()),
  `coforge-token-usage-lifecycle-${crypto.randomUUID()}`,
);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

async function createRuntimeHarness() {
  const connection = { workspaceId: "workspace-a", computerId: "computer-a", workspaceRoot };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  const tokenUsageReports: AgentTokenUsage[] = [];
  const lifecycleOrder: string[] = [];
  let emit: (event: AgentRuntimeEvent) => void = () => {};
  let exitListener: (exit?: AgentSessionExit) => void = () => {};
  let hasLiveTurn = false;
  let flushRelease = Promise.withResolvers<void>();
  let holdFlush = false;

  const session: AgentSession = {
    get hasLiveTurn() {
      return hasLiveTurn;
    },
    async sendMessage() {
      hasLiveTurn = true;
    },
    async notify() {
      hasLiveTurn = true;
    },
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
    onExit(listener) {
      exitListener = listener;
      return () => {};
    },
    async interrupt() {},
    async dispose() {
      hasLiveTurn = false;
    },
  };

  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "codex",
      async createAgentSession() {
        return session;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {
          lifecycleOrder.push("transport.stop");
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentTokenUsage(message) {
          tokenUsageReports.push(message);
          lifecycleOrder.push(`token_usage:${message.turnSeq}`);
        },
        async flushTokenUsage() {
          lifecycleOrder.push("transport.flushTokenUsage:start");
          if (holdFlush) await flushRelease.promise;
          lifecycleOrder.push("transport.flushTokenUsage:done");
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );

  await runtime.start(connection);
  await runtime.startAgent("agent-a", {
    provider: "codex",
    model: "gpt-5.4",
    reasoning: "",
  });

  return {
    runtime,
    tokenUsageReports,
    lifecycleOrder,
    setLiveTurn(live: boolean) {
      hasLiveTurn = live;
    },
    emit(event: AgentRuntimeEvent) {
      emit(event);
    },
    triggerExit(exit?: AgentSessionExit) {
      hasLiveTurn = false;
      exitListener(exit);
    },
    holdShutdownFlush() {
      holdFlush = true;
      flushRelease = Promise.withResolvers<void>();
      return () => flushRelease.resolve();
    },
  };
}

test("flushes token usage on completed, failed, interrupted, and conversation-scoped turns without mixing", async () => {
  const h = await createRuntimeHarness();
  try {
    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      },
    });
    h.emit({
      type: "token-usage",
      conversation: { conversationId: "conv-1", target: "#ops" },
      usage: { uncachedInputTokens: 55, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    });
    h.emit({
      type: "completed",
      status: "completed",
      conversation: { conversationId: "conv-1", target: "#ops" },
    });

    h.emit({
      type: "completed",
      status: "failed",
    });

    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        outputTokens: 20,
      },
    });
    h.emit({
      type: "completed",
      status: "interrupted",
    });

    expect(
      h.tokenUsageReports.map((report) => ({
        turnSeq: report.turnSeq,
        uncached: report.uncachedInputTokens,
        output: report.outputTokens,
      })),
    ).toEqual([
      { turnSeq: 1, uncached: 55, output: 5 },
      { turnSeq: 2, uncached: 100, output: 10 },
      { turnSeq: 3, uncached: 200, output: 20 },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("flushes pending token usage on bare error without completed", async () => {
  const h = await createRuntimeHarness();
  try {
    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 30,
      },
    });
    h.setLiveTurn(false);
    h.emit({
      type: "error",
      message: "transient provider crash",
    });
    expect(h.tokenUsageReports).toHaveLength(1);
    expect(h.tokenUsageReports[0]).toMatchObject({
      turnSeq: 1,
      uncachedInputTokens: 300,
      outputTokens: 30,
    });
  } finally {
    await h.runtime.stop();
  }
});

test("flushes un-flushed pending tokens when a new turn starts so abnormally ended turns never merge", async () => {
  const h = await createRuntimeHarness();
  try {
    h.setLiveTurn(true);
    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
      },
    });
    h.setLiveTurn(false);
    await h.runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "req-msg-1",
      messageId: "msg-1",
      deliveryId: "del-1",
      sequence: 1,
      workspaceId: "workspace-a",
      conversationId: "conv-dm",
      agentId: "agent-a",
      body: "hello",
      method: "agent:v1:message:deliver",
      target: "@agent-a",
    });

    expect(h.tokenUsageReports).toHaveLength(1);
    expect(h.tokenUsageReports[0]).toMatchObject({
      turnSeq: 1,
      uncachedInputTokens: 400,
      outputTokens: 40,
    });

    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 50,
      },
    });
    h.emit({ type: "completed", status: "completed" });
    expect(h.tokenUsageReports).toHaveLength(2);
    expect(h.tokenUsageReports[1]).toMatchObject({
      turnSeq: 2,
      uncachedInputTokens: 500,
      outputTokens: 50,
    });
  } finally {
    await h.runtime.stop();
  }
});

test("flushes pending token usage on process exit and explicit stopAgent", async () => {
  const h = await createRuntimeHarness();
  try {
    h.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 777,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 77,
      },
    });
    h.triggerExit({ code: 137 });

    expect(h.tokenUsageReports).toHaveLength(1);
    expect(h.tokenUsageReports[0]).toMatchObject({
      turnSeq: 1,
      uncachedInputTokens: 777,
      outputTokens: 77,
    });
  } finally {
    await h.runtime.stop();
  }

  const h2 = await createRuntimeHarness();
  try {
    h2.emit({
      type: "token-usage",
      usage: {
        uncachedInputTokens: 888,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 88,
      },
    });
    await h2.runtime.stopAgent("agent-a");

    expect(h2.tokenUsageReports).toHaveLength(1);
    expect(h2.tokenUsageReports[0]).toMatchObject({
      turnSeq: 1,
      uncachedInputTokens: 888,
      outputTokens: 88,
    });
  } finally {
    await h2.runtime.stop();
  }
});

test("flushes pending token usage on daemon stop and drains transport before stopping it", async () => {
  const h = await createRuntimeHarness();
  const release = h.holdShutdownFlush();
  h.emit({
    type: "token-usage",
    usage: { uncachedInputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 99 },
  });

  const stopping = h.runtime.stop();
  await Bun.sleep(10);
  expect(h.tokenUsageReports).toHaveLength(1);
  expect(h.tokenUsageReports[0]).toMatchObject({
    turnSeq: 1,
    uncachedInputTokens: 999,
    outputTokens: 99,
  });
  expect(h.lifecycleOrder).toContain("transport.flushTokenUsage:start");
  expect(h.lifecycleOrder).not.toContain("transport.stop");

  release();
  await stopping;
  expect(h.lifecycleOrder).toEqual([
    "token_usage:1",
    "transport.flushTokenUsage:start",
    "transport.flushTokenUsage:done",
    "transport.stop",
  ]);
});
