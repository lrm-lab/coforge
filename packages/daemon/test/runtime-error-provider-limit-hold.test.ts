import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS } from "#src/agent-runtime/runtime-error-recovery";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-limit-hold-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "claude-code",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const QUOTA_TEXT = "You've hit your session limit · resets 3:45pm";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

/** A runtime with one live Agent whose session the test drives, recording its notices and
 * Activity. */
async function harness() {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const notices: string[] = [];
  const noticed = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  const activities: AgentActivity[] = [];
  const session = {
    async sendMessage() {
      // Startup's first turn ends at once: these tests are about later deliveries.
      for (const listener of listeners) listener({ type: "completed", status: "completed" });
    },
    async notify(notice: string) {
      notices.push(notice);
      noticed.resolve();
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "claude-code", createAgentSession: async () => session }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck() {
          acknowledged.resolve();
        },
        sendAgentActivity(activity) {
          activities.push(activity);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    notices,
    acknowledged: acknowledged.promise,
    activities,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    /** Resolves at the first notice: the observable completion of a released hold. */
    noticed: noticed.promise,
    deliver: (sequence: number) =>
      runtime.handleAgentMessage({
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
        target: "@ada",
      }),
  };
}

/** Fails the current turn on an exhausted quota that resets `resetsAt`, the way Claude Code
 * reports one: the limit, then the failed turn's end. */
function failOnQuota(emit: (event: AgentRuntimeEvent) => void, resetsAt: string) {
  emit({
    type: "error",
    message: QUOTA_TEXT,
    providerErrorCode: "rate_limit",
    providerLimit: { kind: "quota_exhausted", resetsAt },
  });
  emit({ type: "completed", status: "failed" });
}

test("a Claude quota limit holds deliveries until its reported reset time", async () => {
  const { runtime, notices, acknowledged, activities, emit, noticed, deliver } = await harness();
  jest.useFakeTimers();
  try {
    const resetsAt = new Date(Date.now() + 3 * HOUR_MS).toISOString();
    failOnQuota(emit, resetsAt);
    await deliver(1);
    // Held: acknowledged without a notice, unlike the same text unclassified, whose backoff
    // its turn end ends (daemon-runtime.test.ts, "the same error ending every turn ...").
    await acknowledged;
    expect(notices).toEqual([]);
    expect(activities.find((activity) => activity.detailKind === "runtime_error")).toMatchObject({
      detail: `${QUOTA_TEXT} (limit resets at ${resetsAt})`,
      runtimeError: { errorClass: "RateLimitError", errorReason: "quota_exhausted" },
    });

    // Not the exponential backoff's first release, nor its cap: the reset time.
    jest.advanceTimersByTime(RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS * 2);
    await Promise.resolve();
    expect(notices).toEqual([]);
    jest.advanceTimersByTime(3 * HOUR_MS);
    await noticed;
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a reset time beyond the longest timer delay still holds until it", async () => {
  const { runtime, notices, acknowledged, emit, noticed, deliver } = await harness();
  jest.useFakeTimers();
  try {
    // Past 2^31 - 1 ms, where a single timer would fire at once.
    failOnQuota(emit, new Date(Date.now() + 30 * DAY_MS).toISOString());
    await deliver(1);
    await acknowledged;
    jest.advanceTimersByTime(29 * DAY_MS);
    await Promise.resolve();
    expect(notices).toEqual([]);
    jest.advanceTimersByTime(DAY_MS);
    await noticed;
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("progress and side output leave a quota wait; main-session model output ends it", async () => {
  const { runtime, notices, acknowledged, emit, noticed, deliver } = await harness();
  jest.useFakeTimers();
  try {
    failOnQuota(emit, new Date(Date.now() + 3 * HOUR_MS).toISOString());
    await deliver(1);
    await acknowledged;
    // A background subagent still reporting, as in the reference's rate-limit exception.
    const subagent = { parentToolUseId: "toolu_1" };
    emit({ type: "progress" });
    emit({ type: "subagent-progress", phase: "progress", parentToolUseId: "toolu_1" });
    emit({ type: "text-delta", text: "still going", subagent });
    emit({ type: "tool-output", id: "toolu_1", text: "partial" });
    emit({ type: "completed", status: "completed" });
    await Promise.resolve();
    expect(notices).toEqual([]);

    emit({ type: "text-delta", text: "back" });
    emit({ type: "completed", status: "completed" });
    await noticed;
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
